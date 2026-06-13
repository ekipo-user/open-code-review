import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureDatabase } from "../../db/index.js";
import { makeTempWorkspace, removeTempWorkspace } from "../../db/test-support.js";
import {
  stateBegin,
  stateAdvance,
  stateCompleteRound,
  stateClose,
  stateStatus,
  reconcileWorkflowOnExit,
  reconcileCompletedSessions,
} from "../index.js";

let tmpDir: string;
let ocrDir: string;

beforeEach(() => {
  tmpDir = makeTempWorkspace("ocr-reconcile-exit-");
  ocrDir = join(tmpDir, ".ocr");
  mkdirSync(join(ocrDir, "sessions"), { recursive: true });
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
});

const META = JSON.stringify({ schema_version: 1, verdict: "APPROVE", reviewers: [] });

async function begin(id: string): Promise<void> {
  const dir = join(ocrDir, "sessions", id);
  mkdirSync(dir, { recursive: true });
  await stateBegin({
    sessionId: id,
    branch: "feat/x",
    workflowType: "review",
    sessionDir: dir,
    ocrDir,
  });
}

/** Drive a session to the wedge signature: status='active', current_phase='complete',
 *  a `round_completed` event present (the invariant holds) — but never finished. */
async function makeActiveAndComplete(id: string): Promise<void> {
  await begin(id);
  for (const p of [
    "change-context",
    "analysis",
    "reviews",
    "aggregation",
    "discourse",
    "synthesis",
  ]) {
    await stateAdvance({ sessionId: id, phase: p, ocrDir });
  }
  await stateCompleteRound({ source: "stdin", data: META, ocrDir, sessionId: id });
}

describe("reconcileWorkflowOnExit", () => {
  it("closes an active+complete session via the guarded stateClose", async () => {
    await makeActiveAndComplete("wedge");
    // Precondition: the wedge signature — active but already at 'complete'.
    const before = await stateStatus(ocrDir, "wedge");
    expect(before.status).toBe("active");
    expect(before.has_terminal_artifact).toBe(true);

    expect(await reconcileWorkflowOnExit(ocrDir, "wedge")).toBe("closed");

    const after = await stateStatus(ocrDir, "wedge");
    expect(after.status).toBe("closed");
    expect(after.completeness_state).toBe("complete");
  });

  it("no-ops (incomplete) an active session whose round is not complete", async () => {
    await begin("midflight"); // still at 'context', no round_completed
    expect(await reconcileWorkflowOnExit(ocrDir, "midflight")).toBe("incomplete");
    expect((await stateStatus(ocrDir, "midflight")).status).toBe("active");
  });

  it("no-ops (already-closed) a session that is already terminal", async () => {
    await makeActiveAndComplete("done");
    await stateClose({ sessionId: "done", ocrDir });
    expect(await reconcileWorkflowOnExit(ocrDir, "done")).toBe("already-closed");
  });

  it("returns not-found for an unknown session", async () => {
    await ensureDatabase(ocrDir); // create the db with no sessions
    expect(await reconcileWorkflowOnExit(ocrDir, "ghost")).toBe("not-found");
  });

  it("defers while a sibling execution is still in flight, then closes once it finishes", async () => {
    await makeActiveAndComplete("busy");
    const db = await ensureDatabase(ocrDir);
    // A complete round can still have a concurrent execution running. Closing
    // now would cascade-terminate it — so the reconciler must defer.
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id)
       VALUES ('u-busy', 'review', '[]', datetime('now'), 'busy')`,
    );
    expect(await reconcileWorkflowOnExit(ocrDir, "busy")).toBe("in-flight");
    expect((await stateStatus(ocrDir, "busy")).status).toBe("active");

    // The last execution finishes → the session quiesces and now closes.
    db.run(
      `UPDATE command_executions SET finished_at = datetime('now'), exit_code = 0
       WHERE uid = 'u-busy'`,
    );
    expect(await reconcileWorkflowOnExit(ocrDir, "busy")).toBe("closed");
    expect((await stateStatus(ocrDir, "busy")).status).toBe("closed");
  });
});

describe("reconcileCompletedSessions", () => {
  it("closes exactly the active+complete+quiesced sessions and reports their ids", async () => {
    await makeActiveAndComplete("c1");
    await makeActiveAndComplete("c2");
    await begin("incomplete"); // active but not complete → must be left alone
    await makeActiveAndComplete("closed");
    await stateClose({ sessionId: "closed", ocrDir }); // already terminal

    const closed = await reconcileCompletedSessions(ocrDir);

    expect(closed.sort()).toEqual(["c1", "c2"]);
    expect((await stateStatus(ocrDir, "c1")).status).toBe("closed");
    expect((await stateStatus(ocrDir, "c2")).status).toBe("closed");
    expect((await stateStatus(ocrDir, "incomplete")).status).toBe("active");
  });

  it("is idempotent — a second sweep closes nothing further", async () => {
    await makeActiveAndComplete("only");
    expect(await reconcileCompletedSessions(ocrDir)).toEqual(["only"]);
    expect(await reconcileCompletedSessions(ocrDir)).toEqual([]);
  });
});
