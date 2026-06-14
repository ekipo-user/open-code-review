/**
 * Canonical verdict-contract + lifecycle-integrity (D1/D2/D3) end-to-end tests.
 *
 * Khorikov classical (Detroit) school:
 *   • Real subprocess execution of the built `ocr` binary
 *   • Real SQLite database written to a real temp `.ocr/data/` directory
 *   • Real round-meta.json artifacts on a real filesystem
 *   • No internal-module imports, no internal mocks
 *
 * Tests assert observable behavior — exit codes, on-disk artifacts, and
 * cross-invocation state visible to a subsequent `state show --json`.
 *
 * Covers the gaps the unit suites prove only at the integration layer:
 *   • D2 — `complete-round --file` materializes the canonical artifact (parity
 *     with the already-e2e'd `--stdin` path)
 *   • D2 — idempotency: re-run with the artifact present is a no-op; re-run with
 *     the artifact deleted re-materializes it WITHOUT re-advancing the round
 *   • Verdict fail-fast — an off-vocabulary verdict exits 7 (SCHEMA_INVALID) and
 *     writes no artifact
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { spawnCli } from "./helpers/spawn-cli.js";
import {
  createInitializedProject,
  type TempProject,
} from "./helpers/temp-project.js";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((fn) => fn()));

function tracked<T extends TempProject>(project: T): T {
  cleanups.push(project.cleanup);
  return project;
}

const REVIEW_PHASES = [
  "change-context",
  "analysis",
  "reviews",
  "aggregation",
  "discourse",
  "synthesis",
] as const;

/**
 * Begin a review workflow and walk it to the synthesis phase — the atomic
 * complete-round refuses to finalize before proof-of-work, so a round can only
 * be completed from synthesis.
 */
async function beginAndAdvanceToSynthesis(
  project: TempProject,
  sessionId: string,
): Promise<void> {
  const begin = await spawnCli(
    [
      "state",
      "begin",
      "--session-id",
      sessionId,
      "--branch",
      "feat/verdict-contract",
      "--workflow-type",
      "review",
      "--json",
    ],
    { cwd: project.dir },
  );
  expect(begin.exitCode).toBe(0);

  for (const phase of REVIEW_PHASES) {
    const adv = await spawnCli(
      ["state", "advance", "--session-id", sessionId, "--phase", phase],
      { cwd: project.dir },
    );
    expect(adv.exitCode).toBe(0);
  }
}

function roundMetaPath(project: TempProject, sessionId: string): string {
  return resolve(
    project.dir,
    ".ocr",
    "sessions",
    sessionId,
    "rounds",
    "round-1",
    "round-meta.json",
  );
}

function validRoundMeta(): string {
  return JSON.stringify({
    schema_version: 1,
    verdict: "APPROVE",
    reviewers: [
      {
        type: "principal",
        instance: 1,
        findings: [
          {
            title: "Extract the duplicated stdio builder",
            category: "should_fix",
            severity: "medium",
            file_path: "src/adapter.ts",
            line_start: 12,
            line_end: 20,
            summary: "Both adapters duplicate the file-stdio branch.",
          },
        ],
      },
    ],
  });
}

interface ShowResult {
  session: {
    current_round: number;
    current_phase: string;
    phase_number: number;
    status: string;
  };
  events: Array<{ event_type: string }>;
}

async function showState(
  project: TempProject,
  sessionId: string,
): Promise<ShowResult> {
  const res = await spawnCli(
    ["state", "show", "--session-id", sessionId, "--json"],
    { cwd: project.dir },
  );
  expect(res.exitCode).toBe(0);
  return JSON.parse(res.stdout) as ShowResult;
}

function roundCompletedCount(state: ShowResult): number {
  return state.events.filter((e) => e.event_type === "round_completed").length;
}

describe("complete-round --file materializes the canonical artifact (D2)", () => {
  it("writes rounds/round-1/round-meta.json from a --file payload, at parity with --stdin", async () => {
    const project = tracked(createInitializedProject());
    const sessionId = "2026-06-12-feat-file-materialize";
    await beginAndAdvanceToSynthesis(project, sessionId);

    // The payload lives at a NON-canonical path — proving the writer
    // materializes to the canonical round path regardless of input source.
    const payloadPath = resolve(project.dir, "round-payload.json");
    writeFileSync(payloadPath, validRoundMeta());

    const metaPath = roundMetaPath(project, sessionId);
    expect(existsSync(metaPath)).toBe(false);

    const complete = await spawnCli(
      [
        "state",
        "complete-round",
        "--file",
        payloadPath,
        "--session-id",
        sessionId,
        "--json",
      ],
      { cwd: project.dir },
    );
    expect(complete.exitCode).toBe(0);

    // The canonical artifact now exists with the full validated payload.
    expect(existsSync(metaPath)).toBe(true);
    const written = JSON.parse(readFileSync(metaPath, "utf-8")) as {
      schema_version: number;
      verdict: string;
      reviewers: Array<{ findings: unknown[] }>;
    };
    expect(written.schema_version).toBe(1);
    expect(written.verdict).toBe("APPROVE");
    expect(written.reviewers[0]?.findings).toHaveLength(1);
  });
});

describe("complete-round idempotency (D2)", () => {
  it("re-run with the artifact present is a no-op that does not re-advance the round", async () => {
    const project = tracked(createInitializedProject());
    const sessionId = "2026-06-12-feat-idempotent-noop";
    await beginAndAdvanceToSynthesis(project, sessionId);

    const payloadPath = resolve(project.dir, "payload.json");
    writeFileSync(payloadPath, validRoundMeta());

    const first = await spawnCli(
      ["state", "complete-round", "--file", payloadPath, "--session-id", sessionId, "--json"],
      { cwd: project.dir },
    );
    expect(first.exitCode).toBe(0);
    const afterFirst = await showState(project, sessionId);
    expect(roundCompletedCount(afterFirst)).toBe(1);

    // Second identical call: must succeed as a no-op and leave round/phase put.
    const second = await spawnCli(
      ["state", "complete-round", "--file", payloadPath, "--session-id", sessionId, "--json"],
      { cwd: project.dir },
    );
    expect(second.exitCode).toBe(0);
    const afterSecond = await showState(project, sessionId);

    expect(afterSecond.session.current_round).toBe(afterFirst.session.current_round);
    expect(afterSecond.session.current_phase).toBe(afterFirst.session.current_phase);
    expect(afterSecond.session.phase_number).toBe(afterFirst.session.phase_number);
    // The no-op must NOT have committed a second round_completed event.
    expect(roundCompletedCount(afterSecond)).toBe(1);
  });

  it("re-run after the artifact is deleted re-materializes it without re-advancing the round", async () => {
    const project = tracked(createInitializedProject());
    const sessionId = "2026-06-12-feat-self-heal";
    await beginAndAdvanceToSynthesis(project, sessionId);

    const payloadPath = resolve(project.dir, "payload.json");
    writeFileSync(payloadPath, validRoundMeta());

    const first = await spawnCli(
      ["state", "complete-round", "--file", payloadPath, "--session-id", sessionId, "--json"],
      { cwd: project.dir },
    );
    expect(first.exitCode).toBe(0);
    const afterFirst = await showState(project, sessionId);
    expect(roundCompletedCount(afterFirst)).toBe(1);

    // Simulate artifact loss (e.g. a crash between event-commit and write, or a
    // pruned working tree). The recorded round event still exists in the DB.
    const metaPath = roundMetaPath(project, sessionId);
    rmSync(metaPath);
    expect(existsSync(metaPath)).toBe(false);

    // Re-running must self-heal the artifact without duplicating the completion
    // (the round must not advance again, no second round_completed event).
    const heal = await spawnCli(
      ["state", "complete-round", "--file", payloadPath, "--session-id", sessionId, "--json"],
      { cwd: project.dir },
    );
    expect(heal.exitCode).toBe(0);
    expect(existsSync(metaPath)).toBe(true);

    const afterHeal = await showState(project, sessionId);
    expect(afterHeal.session.current_round).toBe(afterFirst.session.current_round);
    expect(afterHeal.session.phase_number).toBe(afterFirst.session.phase_number);
    expect(roundCompletedCount(afterHeal)).toBe(1);
  });
});

describe("verdict fail-fast at complete-round", () => {
  it("rejects an off-vocabulary verdict with SCHEMA_INVALID (exit 7) and writes no artifact", async () => {
    const project = tracked(createInitializedProject());
    const sessionId = "2026-06-12-feat-offvocab-verdict";
    await beginAndAdvanceToSynthesis(project, sessionId);

    // `accept_with_followups` is the retired off-vocabulary value the canonical
    // contract exists to reject at the write boundary.
    const payloadPath = resolve(project.dir, "bad-payload.json");
    writeFileSync(
      payloadPath,
      JSON.stringify({
        schema_version: 1,
        verdict: "accept_with_followups",
        reviewers: [
          {
            type: "principal",
            instance: 1,
            findings: [
              {
                title: "A finding with a sufficiently long title",
                category: "should_fix",
                severity: "medium",
                file_path: "src/x.ts",
                line_start: 1,
                line_end: 2,
                summary: "x",
              },
            ],
          },
        ],
      }),
    );

    const complete = await spawnCli(
      ["state", "complete-round", "--file", payloadPath, "--session-id", sessionId, "--json"],
      { cwd: project.dir },
    );
    expect(complete.exitCode).toBe(7);

    // The round must NOT have been finalized: no canonical artifact, round/phase
    // unchanged (still at synthesis, round 1).
    expect(existsSync(roundMetaPath(project, sessionId))).toBe(false);
    const state = await showState(project, sessionId);
    expect(state.session.current_round).toBe(1);
    expect(state.session.current_phase).toBe("synthesis");
    expect(roundCompletedCount(state)).toBe(0);
  });
});
