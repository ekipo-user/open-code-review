import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
  closeAllDatabases,
  insertSession,
  insertAgentSession,
  getAgentSession,
  listAgentSessionsForWorkflow,
  getLatestAgentSessionWithVendorId,
  bumpAgentSessionHeartbeat,
  setAgentSessionVendorId,
  bindVendorSessionIdOpportunistically,
  setAgentSessionStatus,
  sweepStaleAgentSessions,
  sweepStaleSessions,
} from "../index.js";
import { runMigrations } from "../migrations.js";
import type { Database } from "../engine.js";

let tmpDir: string;
let db: Database;
let dbPath: string;
const WORKFLOW_ID = "2026-04-29-feat-test";

async function freshDb(): Promise<Database> {
  tmpDir = mkdtempSync(join(tmpdir(), "ocr-agent-sessions-test-"));
  dbPath = join(tmpDir, "test.db");
  const conn = await openDatabase(dbPath);
  runMigrations(conn);
  insertSession(conn, {
    id: WORKFLOW_ID,
    branch: "feat/test",
    workflow_type: "review",
    session_dir: ".ocr/sessions/test",
  });
  return conn;
}

beforeEach(async () => {
  db = await freshDb();
});

afterEach(() => {
  closeAllDatabases();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("agent_sessions journal", () => {
  it("inserts a row in 'running' status with a fresh heartbeat", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      persona: "principal",
      instance_index: 1,
      name: "principal-1",
      resolved_model: "claude-opus-4-7",
    });

    const row = getAgentSession(db, "agent-1");
    expect(row).toBeDefined();
    expect(row?.status).toBe("running");
    expect(row?.vendor).toBe("claude");
    expect(row?.persona).toBe("principal");
    expect(row?.resolved_model).toBe("claude-opus-4-7");
    expect(row?.vendor_session_id).toBeNull();
    expect(row?.last_heartbeat_at).toBeTruthy();
  });

  it("lists rows for a workflow ordered by start time", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      persona: "principal",
      instance_index: 1,
    });
    insertAgentSession(db, {
      id: "agent-2",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      persona: "quality",
      instance_index: 1,
    });

    const rows = listAgentSessionsForWorkflow(db, WORKFLOW_ID);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(["agent-1", "agent-2"]);
  });

  it("rejects a vendor-id rebind to a different value", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionVendorId(db, "agent-1", "vendor-abc");
    expect(() =>
      setAgentSessionVendorId(db, "agent-1", "vendor-xyz"),
    ).toThrowError(/already bound/);
  });

  it("allows binding the same vendor id idempotently", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionVendorId(db, "agent-1", "vendor-abc");
    expect(() =>
      setAgentSessionVendorId(db, "agent-1", "vendor-abc"),
    ).not.toThrow();
    const row = getAgentSession(db, "agent-1");
    expect(row?.vendor_session_id).toBe("vendor-abc");
  });

  it("returns the most recent row with a vendor id for a workflow", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionVendorId(db, "agent-1", "vendor-1");
    // Backdate started_at so agent-2 is unambiguously later.
    db.run(
      `UPDATE command_executions SET started_at = datetime('now', '-10 seconds') WHERE uid = 'agent-1'`,
    );

    insertAgentSession(db, {
      id: "agent-2",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionVendorId(db, "agent-2", "vendor-2");

    const latest = getLatestAgentSessionWithVendorId(db, WORKFLOW_ID);
    expect(latest?.id).toBe("agent-2");
    expect(latest?.vendor_session_id).toBe("vendor-2");
  });

  it("transitions to a terminal status with ended_at stamped", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });

    setAgentSessionStatus(db, "agent-1", "done", { exitCode: 0 });

    const row = getAgentSession(db, "agent-1");
    expect(row?.status).toBe("done");
    expect(row?.exit_code).toBe(0);
    expect(row?.ended_at).toBeTruthy();
  });

  it("appends notes on status transitions when provided", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionStatus(db, "agent-1", "crashed", {
      exitCode: 1,
      note: "process killed",
    });
    setAgentSessionStatus(db, "agent-1", "crashed", {
      exitCode: 1,
      note: "second observation",
    });

    const row = getAgentSession(db, "agent-1");
    expect(row?.notes).toContain("process killed");
    expect(row?.notes).toContain("second observation");
  });

  it("bumps last_heartbeat_at", async () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    const before = getAgentSession(db, "agent-1")!.last_heartbeat_at;

    // SQLite datetime('now') has 1-second resolution. Wait just over a second.
    await new Promise((r) => setTimeout(r, 1100));

    bumpAgentSessionHeartbeat(db, "agent-1");
    const after = getAgentSession(db, "agent-1")!.last_heartbeat_at;
    expect(after >= before).toBe(true);
    expect(after).not.toBe(before);
  });
});

describe("sweepStaleAgentSessions", () => {
  it("orphans running rows whose heartbeat is past the threshold", () => {
    insertAgentSession(db, {
      id: "agent-stale",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    // Backdate the heartbeat to 5 minutes ago.
    db.run(
      `UPDATE command_executions
         SET last_heartbeat_at = datetime('now', '-300 seconds')
         WHERE uid = 'agent-stale'`,
    );

    const result = sweepStaleAgentSessions(db, 60);

    expect(result.orphanedIds).toEqual(["agent-stale"]);
    const row = getAgentSession(db, "agent-stale");
    expect(row?.status).toBe("orphaned");
    expect(row?.ended_at).toBeTruthy();
    expect(row?.notes).toContain("orphaned by liveness sweep");
    expect(row?.notes).toContain("threshold 60s");
  });

  it("leaves rows with fresh heartbeats untouched", () => {
    insertAgentSession(db, {
      id: "agent-fresh",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });

    const result = sweepStaleAgentSessions(db, 60);

    expect(result.orphanedIds).toEqual([]);
    const row = getAgentSession(db, "agent-fresh");
    expect(row?.status).toBe("running");
    expect(row?.ended_at).toBeNull();
  });

  it("does not re-touch already-terminal rows", () => {
    insertAgentSession(db, {
      id: "agent-done",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionStatus(db, "agent-done", "done", { exitCode: 0 });
    // Backdate heartbeat past threshold; even so the sweep should ignore it
    // because status is already terminal.
    db.run(
      `UPDATE command_executions
         SET last_heartbeat_at = datetime('now', '-300 seconds')
         WHERE uid = 'agent-done'`,
    );

    const before = getAgentSession(db, "agent-done");
    const result = sweepStaleAgentSessions(db, 60);
    const after = getAgentSession(db, "agent-done");

    expect(result.orphanedIds).toEqual([]);
    expect(after?.status).toBe("done");
    expect(after?.ended_at).toBe(before?.ended_at);
  });

  it("returns an empty result when no rows are stale", () => {
    const result = sweepStaleAgentSessions(db, 60);
    expect(result.orphanedIds).toEqual([]);
  });

  it("orphans multiple stale rows in one call", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    insertAgentSession(db, {
      id: "agent-2",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    db.run(
      `UPDATE command_executions SET last_heartbeat_at = datetime('now', '-300 seconds')`,
    );

    const result = sweepStaleAgentSessions(db, 60);

    expect(result.orphanedIds.sort()).toEqual(["agent-1", "agent-2"]);
    expect(getAgentSession(db, "agent-1")?.status).toBe("orphaned");
    expect(getAgentSession(db, "agent-2")?.status).toBe("orphaned");
  });
});

describe("sweepStaleSessions", () => {
  // Each test seeds its own session and asserts on that session_id
  // alone — the freshDb's WORKFLOW_ID row has no events and would also
  // be swept on every run, so we test inclusion rather than strict
  // array equality.

  it("closes active sessions whose last event is past the threshold", () => {
    insertSession(db, {
      id: "stale-old",
      branch: "feat/stale",
      workflow_type: "review",
      session_dir: ".ocr/sessions/stale-old",
    });
    // Seed a recent event so this session DOES have history — then
    // backdate it to look ancient.
    db.run(
      `INSERT INTO orchestration_events
         (session_id, event_type, phase, phase_number, round, created_at)
       VALUES ('stale-old', 'session_created', 'context', 1, 1, datetime('now', '-30 days'))`,
    );

    const result = sweepStaleSessions(db, 7 * 24 * 60 * 60);

    expect(result.closedSessionIds).toContain("stale-old");
    const after = db.exec("SELECT status FROM sessions WHERE id = 'stale-old'");
    expect(after[0]?.values[0]?.[0]).toBe("closed");
  });

  it("leaves recently-active sessions alone", () => {
    insertSession(db, {
      id: "fresh-session",
      branch: "feat/fresh",
      workflow_type: "review",
      session_dir: ".ocr/sessions/fresh-session",
    });
    // Recent event — sweep should leave this session alone.
    db.run(
      `INSERT INTO orchestration_events
         (session_id, event_type, phase, phase_number, round, created_at)
       VALUES ('fresh-session', 'session_created', 'context', 1, 1, datetime('now'))`,
    );

    const result = sweepStaleSessions(db, 7 * 24 * 60 * 60);
    expect(result.closedSessionIds).not.toContain("fresh-session");
  });

  it("does NOT close a stale-active session that still has in-flight dependents", () => {
    // The invariant: stale sweep only fires when no command_executions
    // are still in flight. Protects long-running but quiet workflows
    // (e.g. an AI thinking for hours without writing a state event).
    insertSession(db, {
      id: "stale-with-deps",
      branch: "feat/sd",
      workflow_type: "review",
      session_dir: ".ocr/sessions/stale-with-deps",
    });
    db.run(
      `INSERT INTO orchestration_events
         (session_id, event_type, phase, phase_number, round, created_at)
       VALUES ('stale-with-deps', 'session_created', 'context', 1, 1, datetime('now', '-30 days'))`,
    );
    // In-flight dependent row: finished_at IS NULL.
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id)
       VALUES ('live-uid', 'review', '[]', datetime('now'), 'stale-with-deps')`,
    );

    const result = sweepStaleSessions(db, 7 * 24 * 60 * 60);

    expect(result.closedSessionIds).not.toContain("stale-with-deps");
    const after = db.exec(
      "SELECT status FROM sessions WHERE id = 'stale-with-deps'",
    );
    expect(after[0]?.values[0]?.[0]).toBe("active");
  });

  it("writes a session_auto_closed_stale event with the threshold", () => {
    insertSession(db, {
      id: "stale-event",
      branch: "feat/se",
      workflow_type: "review",
      session_dir: ".ocr/sessions/stale-event",
    });
    db.run(
      `INSERT INTO orchestration_events
         (session_id, event_type, phase, phase_number, round, created_at)
       VALUES ('stale-event', 'session_created', 'context', 1, 1, datetime('now', '-30 days'))`,
    );

    sweepStaleSessions(db, 7 * 24 * 60 * 60);

    const events = db.exec(
      `SELECT metadata FROM orchestration_events
        WHERE session_id = 'stale-event'
          AND event_type = 'session_auto_closed_stale'`,
    );
    expect(events[0]?.values.length).toBe(1);
    const metadata = JSON.parse(events[0]!.values[0]![0] as string);
    expect(metadata.threshold_seconds).toBe(7 * 24 * 60 * 60);
  });
});

describe("bindVendorSessionIdOpportunistically", () => {
  it("returns null when no candidate row exists", () => {
    const result = bindVendorSessionIdOpportunistically(db, "vendor-xyz");
    expect(result).toBeNull();
  });

  it("binds to the most recent unbound running row", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    db.run(
      `UPDATE command_executions SET started_at = datetime('now', '-10 seconds') WHERE uid = 'agent-1'`,
    );
    insertAgentSession(db, {
      id: "agent-2",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });

    const bound = bindVendorSessionIdOpportunistically(db, "vendor-xyz");
    expect(bound).toBe("agent-2");
    expect(getAgentSession(db, "agent-2")?.vendor_session_id).toBe("vendor-xyz");
    expect(getAgentSession(db, "agent-1")?.vendor_session_id).toBeNull();
  });

  it("is idempotent when the same vendor id is already bound", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionVendorId(db, "agent-1", "vendor-xyz");

    const bound = bindVendorSessionIdOpportunistically(db, "vendor-xyz");
    expect(bound).toBe("agent-1");
  });

  it("ignores rows in inactive workflows", () => {
    db.run(
      `INSERT INTO orchestration_events (session_id, event_type, created_at) VALUES (?, 'session_synced', datetime('now'))`,
      [WORKFLOW_ID],
    );
    db.run(`UPDATE sessions SET status = 'closed' WHERE id = ?`, [WORKFLOW_ID]);
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    const bound = bindVendorSessionIdOpportunistically(db, "vendor-xyz");
    expect(bound).toBeNull();
    expect(getAgentSession(db, "agent-1")?.vendor_session_id).toBeNull();
  });

  it("ignores rows that already have a different vendor id bound", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionVendorId(db, "agent-1", "vendor-existing");
    insertAgentSession(db, {
      id: "agent-2",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });

    const bound = bindVendorSessionIdOpportunistically(db, "vendor-new");
    expect(bound).toBe("agent-2");
    expect(getAgentSession(db, "agent-1")?.vendor_session_id).toBe("vendor-existing");
  });

  it("ignores terminal rows", () => {
    insertAgentSession(db, {
      id: "agent-done",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });
    setAgentSessionStatus(db, "agent-done", "done", { exitCode: 0 });

    const bound = bindVendorSessionIdOpportunistically(db, "vendor-xyz");
    expect(bound).toBeNull();
  });
});

describe("foreign key integrity", () => {
  it("rejects deletion of a workflow that has agent_sessions", () => {
    insertAgentSession(db, {
      id: "agent-1",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
    });

    expect(() =>
      db.run(`DELETE FROM sessions WHERE id = ?`, [WORKFLOW_ID]),
    ).toThrow();
  });
});
