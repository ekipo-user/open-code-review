import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
  closeAllDatabases,
  runMigrations,
  getSession,
  insertSession,
  insertEvent,
  updateSession,
} from "../../db/index.js";
import { openEngine } from "../../db/engine.js";
import {
  stateInit,
  stateTransition,
  stateRoundComplete,
  stateClose,
  rebuildSessionProjection,
} from "../index.js";

let tmpDir: string;
let ocrDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ocr-proj-"));
  ocrDir = join(tmpDir, ".ocr");
  mkdirSync(join(ocrDir, "sessions"), { recursive: true });
});

afterEach(() => {
  closeAllDatabases();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("event-sourced projection", () => {
  it("rebuilds the sessions projection purely from the event log", async () => {
    const sessionDir = join(ocrDir, "sessions", "proj-1");
    mkdirSync(sessionDir, { recursive: true });
    await stateInit({
      sessionId: "proj-1",
      branch: "feat/p",
      workflowType: "review",
      sessionDir,
      ocrDir,
    });
    for (const [phase, n] of [
      ["change-context", 2],
      ["analysis", 3],
      ["reviews", 4],
      ["aggregation", 5],
      ["discourse", 6],
      ["synthesis", 7],
    ] as const) {
      await stateTransition({ sessionId: "proj-1", phase, phaseNumber: n, ocrDir });
    }
    await stateRoundComplete({
      source: "stdin",
      ocrDir,
      sessionId: "proj-1",
      data: JSON.stringify({
        schema_version: 1,
        verdict: "APPROVE",
        reviewers: [],
      }),
    });
    await stateClose({ sessionId: "proj-1", ocrDir });

    const db = await openDatabase(join(ocrDir, "data", "ocr.db"));
    const live = getSession(db, "proj-1")!;
    const rebuilt = rebuildSessionProjection(db, "proj-1")!;

    expect(rebuilt).toEqual({
      status: live.status,
      current_phase: live.current_phase,
      phase_number: live.phase_number,
      current_round: live.current_round,
      current_map_run: live.current_map_run,
    });
  });
});

describe("concurrent writers under WAL", () => {
  it("a separate process's lifecycle close + round survive a concurrent dashboard write", async () => {
    // Two distinct connections to the same on-disk database (bypass the
    // per-path connection cache) — mimicking the CLI process and the
    // dashboard process writing concurrently. Under sql.js this was the
    // clobber bug; under better-sqlite3 + WAL it must be lossless.
    const dbPath = join(ocrDir, "data", "ocr.db");
    mkdirSync(join(ocrDir, "data"), { recursive: true });

    const cli = openEngine(dbPath);
    runMigrations(cli);

    // CLI: create + complete + close a review session in one logical unit.
    insertSession(cli, {
      id: "wf",
      branch: "feat/w",
      workflow_type: "review",
      session_dir: ".ocr/sessions/wf",
    });
    insertEvent(cli, { session_id: "wf", event_type: "session_created", round: 1 });
    insertEvent(cli, { session_id: "wf", event_type: "round_completed", round: 1 });

    // Dashboard (separate connection): write its own table concurrently.
    const dashboard = openEngine(dbPath);
    dashboard.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id, last_heartbeat_at)
       VALUES ('u-dash', 'review', '[]', datetime('now'), 'wf', datetime('now'))`,
    );

    // CLI closes after the dashboard's interleaved write.
    updateSession(cli, "wf", { status: "closed", current_phase: "complete" });

    cli.close();
    dashboard.close();

    // Fresh reader sees BOTH writers' effects — nothing clobbered.
    const reader = openEngine(dbPath);
    const completeness = reader.exec(
      "SELECT completeness_state FROM session_completeness WHERE session_id = 'wf'",
    );
    const dashRow = reader.exec(
      "SELECT 1 FROM command_executions WHERE uid = 'u-dash'",
    );
    reader.close();

    expect(completeness[0]?.values[0]?.[0]).toBe("complete");
    expect(dashRow[0]?.values.length).toBe(1);
  });
});
