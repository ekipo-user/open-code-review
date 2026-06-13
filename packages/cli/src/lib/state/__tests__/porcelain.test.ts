import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureDatabase, getSession } from "../../db/index.js";
import { makeTempWorkspace, removeTempWorkspace } from "../../db/test-support.js";
import {
  stateBegin,
  stateAdvance,
  stateCompleteRound,
  stateClose,
  stateStatus,
  stateSync,
  rebuildSessionProjection,
  STATE_EXIT,
} from "../index.js";

let tmpDir: string;
let ocrDir: string;

beforeEach(() => {
  tmpDir = makeTempWorkspace("ocr-porcelain-");
  ocrDir = join(tmpDir, ".ocr");
  mkdirSync(join(ocrDir, "sessions"), { recursive: true });
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
});

const META = JSON.stringify({ schema_version: 1, verdict: "APPROVE", reviewers: [] });

async function begin(id: string): Promise<string> {
  const dir = join(ocrDir, "sessions", id);
  mkdirSync(dir, { recursive: true });
  await stateBegin({ sessionId: id, branch: "feat/x", workflowType: "review", sessionDir: dir, ocrDir });
  return dir;
}

async function walkToSynthesis(id: string): Promise<void> {
  for (const p of ["change-context", "analysis", "reviews", "aggregation", "discourse", "synthesis"]) {
    await stateAdvance({ sessionId: id, phase: p, ocrDir });
  }
}

describe("stateAdvance", () => {
  it("derives the phase number and validates the graph", async () => {
    await begin("adv");
    await stateAdvance({ sessionId: "adv", phase: "change-context", ocrDir });
    const status = await stateStatus(ocrDir, "adv");
    expect(status.current_phase).toBe("change-context");
  });

  it("rejects an illegal jump with ILLEGAL_TRANSITION", async () => {
    await begin("adv2");
    await expect(stateAdvance({ sessionId: "adv2", phase: "complete", ocrDir })).rejects.toMatchObject({
      code: STATE_EXIT.ILLEGAL_TRANSITION,
    });
  });
});

describe("stateCompleteRound", () => {
  it("atomically finalizes a round and marks it complete", async () => {
    await begin("cr");
    await walkToSynthesis("cr");
    const result = await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "cr" });
    expect(result.round).toBe(1);
    const status = await stateStatus(ocrDir, "cr");
    expect(status.current_phase).toBe("complete");
    expect(status.has_terminal_artifact).toBe(true);
  });

  it("is idempotent for an already-completed round", async () => {
    await begin("cr2");
    await walkToSynthesis("cr2");
    await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "cr2" });
    await expect(
      stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "cr2" }),
    ).resolves.toMatchObject({ round: 1 });
  });

  it("refuses with INVARIANT_UNMET when not at synthesis", async () => {
    await begin("cr3"); // still at 'context'
    await expect(
      stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "cr3" }),
    ).rejects.toMatchObject({ code: STATE_EXIT.INVARIANT_UNMET });
  });

  it("rejects invalid metadata with SCHEMA_INVALID", async () => {
    await begin("cr4");
    await walkToSynthesis("cr4");
    await expect(
      stateCompleteRound({ source: "stdin", data: "{ not valid", ocrDir, sessionId: "cr4" }),
    ).rejects.toMatchObject({ code: STATE_EXIT.SCHEMA_INVALID });
  });

  it("honors --require-final", async () => {
    const dir = await begin("cr5");
    await walkToSynthesis("cr5");
    await expect(
      stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "cr5", requireFinal: true }),
    ).rejects.toMatchObject({ code: STATE_EXIT.INVARIANT_UNMET });
    mkdirSync(join(dir, "rounds", "round-1"), { recursive: true });
    writeFileSync(join(dir, "rounds", "round-1", "final.md"), "# Final\n");
    await expect(
      stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "cr5", requireFinal: true }),
    ).resolves.toBeDefined();
  });
});

describe("finish (invariant-checked close)", () => {
  it("refuses to close an incomplete session", async () => {
    await begin("fin");
    await expect(stateClose({ sessionId: "fin", ocrDir })).rejects.toMatchObject({
      code: STATE_EXIT.INVARIANT_UNMET,
    });
  });

  it("closes a completed session", async () => {
    await begin("fin2");
    await walkToSynthesis("fin2");
    await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "fin2" });
    await expect(stateClose({ sessionId: "fin2", ocrDir })).resolves.toBeUndefined();
    const status = await stateStatus(ocrDir, "fin2");
    expect(status.completeness_state).toBe("complete");
  });

  it("abort records a non-success terminal", async () => {
    await begin("fin3");
    await stateClose({ sessionId: "fin3", ocrDir, abort: true });
    const status = await stateStatus(ocrDir, "fin3");
    // closed, but not 'complete' (no artifact) — a recorded abandonment.
    expect(status.status).toBe("closed");
    expect(status.completeness_state).toBe("closed_without_artifact");
  });
});

describe("stateStatus", () => {
  it("reports open_no_artifact → round-done → complete", async () => {
    await begin("st");
    expect((await stateStatus(ocrDir, "st")).completeness_state).toBe("open_no_artifact");
    await walkToSynthesis("st");
    await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "st" });
    // Round finalized but session still open — next action is to finish.
    const mid = await stateStatus(ocrDir, "st");
    expect(mid.completeness_state).toBe("open_no_artifact");
    expect(mid.has_terminal_artifact).toBe(true);
    // Branch on next_action_kind (typed), not the prose next_action — the
    // dedicated test below pins it. Substring-matching prose is the contract
    // SF14 eliminated.
    expect(mid.next_action_kind).toBe("finish");
    await stateClose({ sessionId: "st", ocrDir });
    expect((await stateStatus(ocrDir, "st")).completeness_state).toBe("complete");
  });

  it("exposes a machine-branchable next_action_kind alongside the prose", async () => {
    await begin("nk");
    // Fresh open session → advance.
    expect((await stateStatus(ocrDir, "nk")).next_action_kind).toBe("advance");
    await walkToSynthesis("nk");
    // At synthesis, no artifact yet → complete_round.
    expect((await stateStatus(ocrDir, "nk")).next_action_kind).toBe("complete_round");
    await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "nk" });
    // Artifact present, still open → finish.
    expect((await stateStatus(ocrDir, "nk")).next_action_kind).toBe("finish");
    await stateClose({ sessionId: "nk", ocrDir });
    // Complete → none.
    expect((await stateStatus(ocrDir, "nk")).next_action_kind).toBe("none");
  });

  it("stamps schema_version on the status envelope", async () => {
    await begin("sv");
    expect((await stateStatus(ocrDir, "sv")).schema_version).toBe(1);
  });
});

describe("Blocker 2 — projection equals live after a session_synced close", () => {
  it("rebuildSessionProjection marks a stateSync-closed session 'closed'", async () => {
    // Build a session directory on disk with a completed round artifact, then
    // sync it (which closes it via a session_synced reason event). The folded
    // projection must agree the session is closed — previously session_synced
    // was missing from the terminal set so the fold left it 'active'.
    const id = "2026-06-01-synced";
    const dir = join(ocrDir, "sessions", id, "rounds", "round-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "final.md"), "# Final\n");

    const synced = await stateSync(ocrDir);
    expect(synced).toBe(1);

    const db = await ensureDatabase(ocrDir);
    const live = getSession(db, id);
    expect(live?.status).toBe("closed");

    const derived = rebuildSessionProjection(db, id);
    expect(derived).not.toBeNull();
    expect(derived?.status).toBe("closed");
    // The fold and the live projection agree on the closed lifecycle.
    expect(derived?.status).toBe(live?.status);
  });
});

describe("SF9 — idempotent complete-round returns a stable metaPath", () => {
  it("returns the same metaPath on the first and the idempotent second call", async () => {
    await begin("idem");
    await walkToSynthesis("idem");
    const first = await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "idem" });
    const second = await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "idem" });
    expect(first.metaPath).toBeDefined();
    expect(second.metaPath).toBe(first.metaPath);
    expect(second.round).toBe(first.round);
  });
});

describe("SF15 — CLI-reachable errors carry a STATE_EXIT code", () => {
  it("advance on a missing session yields NOT_FOUND", async () => {
    // Create a DB so the open succeeds, then target a non-existent session.
    await begin("present");
    await expect(
      stateAdvance({ sessionId: "no-such-session", phase: "change-context", ocrDir }),
    ).rejects.toMatchObject({ code: STATE_EXIT.NOT_FOUND });
  });

  it("complete-round on a non-existent file yields SCHEMA_INVALID (atomic path wraps the read error)", async () => {
    await begin("nf");
    await walkToSynthesis("nf");
    await expect(
      stateCompleteRound({
        source: "file",
        filePath: join(ocrDir, "does-not-exist.json"),
        ocrDir,
        sessionId: "nf",
      }),
    ).rejects.toMatchObject({ code: STATE_EXIT.SCHEMA_INVALID });
  });
});

describe("S17 — round boundary only resets to the initial phase", () => {
  it("rejects a round-boundary jump to a non-initial phase", async () => {
    await begin("rb");
    await walkToSynthesis("rb");
    await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: "rb" });
    // Bumping the round while jumping to 'reviews' (not 'context') is illegal.
    await expect(
      stateAdvance({ sessionId: "rb", phase: "reviews", round: 2, ocrDir }),
    ).rejects.toMatchObject({ code: STATE_EXIT.ILLEGAL_TRANSITION });
    // Resetting to the initial phase on the new round is allowed.
    await expect(
      stateAdvance({ sessionId: "rb", phase: "context", round: 2, ocrDir }),
    ).resolves.toBeUndefined();
  });
});