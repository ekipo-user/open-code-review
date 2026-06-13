import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
  runMigrations,
  getSession,
  insertSession,
  insertEvent,
  updateSession,
} from "../../db/index.js";
import { makeTempWorkspace, removeTempWorkspace } from "../../db/test-support.js";
import { openEngine } from "../../db/engine.js";
import {
  stateInit,
  stateTransition,
  stateCompleteRound,
  stateClose,
  rebuildSessionProjection,
} from "../index.js";

let tmpDir: string;
let ocrDir: string;

beforeEach(() => {
  tmpDir = makeTempWorkspace("ocr-proj-");
  ocrDir = join(tmpDir, ".ocr");
  mkdirSync(join(ocrDir, "sessions"), { recursive: true });
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
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
    // A completed round must exist before the projection assertion. The atomic
    // finalize requires the workflow to have reached synthesis (proof of work)
    // — the transitions above walk it there — and then transitions to complete.
    await stateCompleteRound({
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

describe("cross-connection co-existence under WAL", () => {
  it("two connections' interleaved writes are both lossless (the sql.js clobber class)", async () => {
    // Two distinct connections to the same on-disk database (bypass the
    // per-path connection cache) — the CLI process and the dashboard process.
    // Writes are SEQUENCED here (not contended); the point is that an
    // interleaved write from connection B does not clobber connection A's
    // earlier write, which is exactly the sql.js full-image-export bug.
    // Genuine lock contention is exercised by the next test.
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

  it("a contended write waits out a separate process's held write lock (true contention)", async () => {
    // Genuine cross-PROCESS contention: a child process opens the same DB,
    // takes the WAL writer lock (BEGIN IMMEDIATE), holds it for ~400ms, then
    // commits. Meanwhile the parent issues its own transactional write, which
    // must block on the lock and then succeed (via busy_timeout + the engine's
    // SQLITE_BUSY retry) — not fail late as the pre-WAL design would.
    // The child holds the writer lock far longer than the parent's stagger plus
    // its own busy-retry budget (BUSY_RETRY_ATTEMPTS × BUSY_RETRY_BACKOFF_MS =
    // 5 × 50 = 250ms), so the parent genuinely contends and must wait it out via
    // busy_timeout — not fail fast.
    const CHILD_HOLD_MS = 400;
    const PARENT_STAGGER_MS = 120; // let the child take the lock first

    const dbPath = join(ocrDir, "data", "ocr.db");
    mkdirSync(join(ocrDir, "data"), { recursive: true });

    const parent = openEngine(dbPath);
    runMigrations(parent);
    insertSession(parent, {
      id: "wf",
      branch: "feat/w",
      workflow_type: "review",
      session_dir: ".ocr/sessions/wf",
    });

    // Child script (CJS): hold the writer lock for ~400ms inside one txn.
    // Uses Node's built-in node:sqlite (no native dependency to resolve).
    const childPath = join(ocrDir, "data", "lock-holder.cjs");
    writeFileSync(
      childPath,
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[2]);
       db.exec("PRAGMA journal_mode = WAL");
       db.exec("PRAGMA busy_timeout = 5000");
       db.exec("BEGIN IMMEDIATE");
       db.prepare("INSERT INTO command_executions (uid, command, args, started_at, workflow_id) VALUES ('u-child','review','[]',datetime('now'),'wf')").run();
       const until = Date.now() + ${CHILD_HOLD_MS};
       while (Date.now() < until) { /* hold the write lock */ }
       db.exec("COMMIT");
       db.close();
      `,
    );

    const childDone = new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [childPath, dbPath], {
        stdio: "ignore",
      });
      child.on("exit", (code) => resolve(code ?? -1));
    });

    // Let the child acquire the writer lock first.
    await new Promise((r) => setTimeout(r, PARENT_STAGGER_MS));

    // Parent's transactional write contends with the held lock and must win
    // (after the child releases) rather than throwing.
    expect(() =>
      parent.transaction(() => {
        updateSession(parent, "wf", { current_round: 2 });
      }),
    ).not.toThrow();

    const childExit = await childDone;
    parent.close();

    expect(childExit).toBe(0);

    // Both writers' effects are durably present — nothing was lost to contention.
    const reader = openEngine(dbPath);
    const round = reader.exec("SELECT current_round FROM sessions WHERE id = 'wf'");
    const childRow = reader.exec("SELECT 1 FROM command_executions WHERE uid = 'u-child'");
    reader.close();
    expect(round[0]?.values[0]?.[0]).toBe(2);
    expect(childRow[0]?.values.length).toBe(1);
  });
});
