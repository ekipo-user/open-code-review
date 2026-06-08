import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeAllDatabases } from "../../db/index.js";
import {
  stateBegin,
  stateAdvance,
  stateCompleteRound,
  stateClose,
  stateStatus,
  STATE_EXIT,
} from "../index.js";

let tmpDir: string;
let ocrDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ocr-porcelain-"));
  ocrDir = join(tmpDir, ".ocr");
  mkdirSync(join(ocrDir, "sessions"), { recursive: true });
});

afterEach(() => {
  closeAllDatabases();
  rmSync(tmpDir, { recursive: true, force: true });
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
    expect(mid.next_action).toContain("finish");
    await stateClose({ sessionId: "st", ocrDir });
    expect((await stateStatus(ocrDir, "st")).completeness_state).toBe("complete");
  });
});