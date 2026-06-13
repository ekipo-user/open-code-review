import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
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
  commitReasonClose,
  insertEvent,
  rowKind,
} from "../index.js";
import { makeTempWorkspace, removeTempWorkspace } from "../test-support.js";
import { runMigrations } from "../migrations.js";
import type { Database } from "../engine.js";

let tmpDir: string;
let db: Database;
let dbPath: string;
const WORKFLOW_ID = "2026-04-29-feat-test";

async function freshDb(): Promise<Database> {
  tmpDir = makeTempWorkspace("ocr-agent-sessions-test-");
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
  removeTempWorkspace(tmpDir);
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
  // The terminal "orphaned" verdict is grounded in actual process liveness,
  // not heartbeat age — the sweep takes an `isAlive(pid)` predicate so these
  // tests are deterministic without spawning real processes.
  const ALIVE = () => true;
  const DEAD = () => false;
  /** Backdate a row's heartbeat past the 60s threshold. */
  function makeStale(uid: string) {
    db.run(
      `UPDATE command_executions
         SET last_heartbeat_at = datetime('now', '-300 seconds')
         WHERE uid = ?`,
      [uid],
    );
  }

  it("NEVER orphans a row whose pid is alive, even with an ancient heartbeat", () => {
    // The regression: a long-running review (live pid) must not be falsely
    // declared dead just because its heartbeat lapsed.
    insertAgentSession(db, {
      id: "agent-alive",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      pid: 4242,
    });
    makeStale("agent-alive");

    const result = sweepStaleAgentSessions(db, 60, ALIVE);

    expect(result.orphanedIds).toEqual([]);
    const row = getAgentSession(db, "agent-alive");
    expect(row?.status).toBe("running");
    expect(row?.ended_at).toBeNull();
  });

  it("orphans a row whose pid is confirmed dead", () => {
    insertAgentSession(db, {
      id: "agent-dead",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      pid: 4242,
    });
    makeStale("agent-dead");

    const result = sweepStaleAgentSessions(db, 60, DEAD);

    expect(result.orphanedIds).toEqual(["agent-dead"]);
    const row = getAgentSession(db, "agent-dead");
    expect(row?.status).toBe("orphaned");
    expect(row?.ended_at).toBeTruthy();
    expect(row?.notes).toContain("orphaned by liveness sweep");
    expect(row?.notes).toContain("threshold 60s");
    // pid cleared so a second sweep can't re-consider it.
    const pidRow = db.exec(
      "SELECT pid FROM command_executions WHERE uid = 'agent-dead'",
    );
    expect(pidRow[0]?.values[0]?.[0]).toBeNull();
  });

  it("NEVER orphans a row with no recorded pid (no evidence of death)", () => {
    insertAgentSession(db, {
      id: "agent-nopid",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      // no pid
    });
    makeStale("agent-nopid");

    // The predicate must not even be consulted for a null-pid row.
    const result = sweepStaleAgentSessions(db, 60, () => {
      throw new Error("isAlive must not be probed for a null pid");
    });

    expect(result.orphanedIds).toEqual([]);
    expect(getAgentSession(db, "agent-nopid")?.status).toBe("running");
    expect(getAgentSession(db, "agent-nopid")?.ended_at).toBeNull();
  });

  it("orphans a dead-pid row just inside the 24h PID-reuse window", () => {
    insertAgentSession(db, {
      id: "agent-23h",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      pid: 4242,
    });
    db.run(
      `UPDATE command_executions
         SET last_heartbeat_at = datetime('now', '-300 seconds'),
             started_at = datetime('now', '-23 hours')
         WHERE uid = 'agent-23h'`,
    );

    const result = sweepStaleAgentSessions(db, 60, DEAD);
    expect(result.orphanedIds).toEqual(["agent-23h"]);
  });

  it("does NOT orphan a row older than the 24h PID-reuse window (pid may be recycled)", () => {
    insertAgentSession(db, {
      id: "agent-25h",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      pid: 4242,
    });
    db.run(
      `UPDATE command_executions
         SET last_heartbeat_at = datetime('now', '-300 seconds'),
             started_at = datetime('now', '-25 hours')
         WHERE uid = 'agent-25h'`,
    );

    // Even with a "dead" probe, an ancient row is left alone — its pid can't
    // be trusted (the OS may have recycled it onto an unrelated process).
    const result = sweepStaleAgentSessions(db, 60, DEAD);
    expect(result.orphanedIds).toEqual([]);
    expect(getAgentSession(db, "agent-25h")?.status).toBe("running");
  });

  it("honors the 24h guard for ISO-format started_at (the dashboard writer's shape)", () => {
    // The dashboard's command-runner writes started_at = Date.toISOString(),
    // NOT SQLite's `datetime('now')`. The reuse guard parses it via sqliteUtcMs;
    // a regression there returned NaN, so `NaN < cutoff` was always false and
    // the guard silently failed open. Insert the ISO shape directly to pin it.
    const isoOld = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const isoStale = new Date(Date.now() - 300 * 1000).toISOString();
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id, pid, last_heartbeat_at)
       VALUES ('iso-25h', 'review', '[]', ?, ?, 4242, ?)`,
      [isoOld, WORKFLOW_ID, isoStale],
    );

    // pid "dead", but the row is >24h old (ISO) → guard must trip → NOT orphaned.
    const past = sweepStaleAgentSessions(db, 60, DEAD);
    expect(past.orphanedIds).not.toContain("iso-25h");
    expect(getAgentSession(db, "iso-25h")?.status).toBe("running");

    // A within-window ISO row with a dead pid IS orphaned (guard lets it through).
    const isoRecent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id, pid, last_heartbeat_at)
       VALUES ('iso-2h', 'review', '[]', ?, ?, 4243, ?)`,
      [isoRecent, WORKFLOW_ID, isoStale],
    );
    const recent = sweepStaleAgentSessions(db, 60, DEAD);
    expect(recent.orphanedIds).toContain("iso-2h");
  });

  it("leaves rows with fresh heartbeats untouched", () => {
    insertAgentSession(db, {
      id: "agent-fresh",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      pid: 4242,
    });

    const result = sweepStaleAgentSessions(db, 60, DEAD);

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
      pid: 4242,
    });
    setAgentSessionStatus(db, "agent-done", "done", { exitCode: 0 });
    makeStale("agent-done");

    const before = getAgentSession(db, "agent-done");
    const result = sweepStaleAgentSessions(db, 60, DEAD);
    const after = getAgentSession(db, "agent-done");

    expect(result.orphanedIds).toEqual([]);
    expect(after?.status).toBe("done");
    expect(after?.ended_at).toBe(before?.ended_at);
  });

  it("returns an empty result when no rows are stale", () => {
    const result = sweepStaleAgentSessions(db, 60, DEAD);
    expect(result.orphanedIds).toEqual([]);
  });

  it("is idempotent — a second sweep makes no further change", () => {
    insertAgentSession(db, {
      id: "agent-idem",
      workflow_id: WORKFLOW_ID,
      vendor: "claude",
      pid: 4242,
    });
    makeStale("agent-idem");

    const first = sweepStaleAgentSessions(db, 60, DEAD);
    expect(first.orphanedIds).toEqual(["agent-idem"]);
    const endedAt = getAgentSession(db, "agent-idem")?.ended_at;

    const second = sweepStaleAgentSessions(db, 60, DEAD);
    expect(second.orphanedIds).toEqual([]);
    expect(getAgentSession(db, "agent-idem")?.ended_at).toBe(endedAt);
  });

  it("orphans only the dead rows in a mixed batch", () => {
    insertAgentSession(db, { id: "alive-1", workflow_id: WORKFLOW_ID, vendor: "claude", pid: 1001 });
    insertAgentSession(db, { id: "dead-1", workflow_id: WORKFLOW_ID, vendor: "claude", pid: 2002 });
    makeStale("alive-1");
    makeStale("dead-1");

    // Probe: only pid 2002 is dead.
    const result = sweepStaleAgentSessions(db, 60, (pid) => pid !== 2002);

    expect(result.orphanedIds).toEqual(["dead-1"]);
    expect(getAgentSession(db, "alive-1")?.status).toBe("running");
    expect(getAgentSession(db, "dead-1")?.status).toBe("orphaned");
  });
});

describe("rowKind", () => {
  it("classifies the three row kinds from command + heartbeat", () => {
    // instance — both the persona'd and the bare (persona-less) forms.
    expect(rowKind({ command: "session-instance:principal-1", last_heartbeat_at: "x" })).toBe("instance");
    expect(rowKind({ command: "session-instance", last_heartbeat_at: "x" })).toBe("instance");
    expect(rowKind({ command: "session-instance", last_heartbeat_at: null })).toBe("instance");
    // supervisor — a journaled (heartbeat-bearing) non-instance command.
    expect(rowKind({ command: "review", last_heartbeat_at: "x" })).toBe("supervisor");
    expect(rowKind({ command: "map", last_heartbeat_at: "x" })).toBe("supervisor");
    // utility — a non-instance command with no journaled heartbeat.
    expect(rowKind({ command: "post", last_heartbeat_at: null })).toBe("utility");
    expect(rowKind({ command: "doctor", last_heartbeat_at: null })).toBe("utility");
  });

  it("does NOT classify a command merely PREFIXED 'session-instance' as an instance", () => {
    // The load-bearing cascade-safety contract: the reader is exact-or-`:`-
    // suffixed, NOT a loose startsWith. A look-alike command must read as a
    // supervisor — otherwise an orphaned look-alike could cascade-kill its
    // workflow's live siblings. A revert to loose `startsWith` must fail here.
    expect(rowKind({ command: "session-instances", last_heartbeat_at: "x" })).toBe("supervisor");
    expect(rowKind({ command: "session-instance-x", last_heartbeat_at: "x" })).toBe("supervisor");
    expect(rowKind({ command: "session-instance ", last_heartbeat_at: "x" })).toBe("supervisor");
  });
});

describe("sweepStaleAgentSessions — cascade on a dead supervisor", () => {
  const DEAD = () => false;
  // Insert a workflow-supervisor row (a real command, not a session-instance).
  function insertSupervisor(uid: string, workflowId: string, pid: number) {
    db.run(
      `INSERT INTO command_executions
         (uid, command, args, started_at, workflow_id, pid, last_heartbeat_at)
       VALUES (?, 'review', '[]', datetime('now'), ?, ?, datetime('now', '-300 seconds'))`,
      [uid, workflowId, pid],
    );
  }
  function makeStale(uid: string) {
    db.run(
      `UPDATE command_executions SET last_heartbeat_at = datetime('now', '-300 seconds') WHERE uid = ?`,
      [uid],
    );
  }

  it("cascade-terminates a dead supervisor's in-flight dependents with -4", () => {
    insertSession(db, { id: "wf-sup", branch: "feat/s", workflow_type: "review", session_dir: ".ocr/sessions/wf-sup" });
    insertSupervisor("sup-dead", "wf-sup", 4242);
    // A live in-flight reviewer instance owned by the same workflow.
    insertAgentSession(db, { id: "child", workflow_id: "wf-sup", vendor: "claude" });

    const result = sweepStaleAgentSessions(db, 60, DEAD);

    expect(result.orphanedIds).toEqual(["sup-dead"]);
    expect(getAgentSession(db, "sup-dead")?.status).toBe("orphaned"); // -3
    const child = getAgentSession(db, "child");
    expect(child?.status).toBe("cancelled"); // -4 derives to cancelled
    expect(child?.exit_code).toBe(-4);
    expect(child?.ended_at).toBeTruthy();
  });

  it("does NOT cascade when the dead row is itself a reviewer instance (colon or bare)", () => {
    insertSession(db, { id: "wf-inst", branch: "feat/i", workflow_type: "review", session_dir: ".ocr/sessions/wf-inst" });
    // Two pid-bearing instances in the same workflow; one dead, one (sibling) live.
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id, pid, last_heartbeat_at)
       VALUES ('inst-dead', 'session-instance:principal-1', '[]', datetime('now'), 'wf-inst', 4242, datetime('now','-300 seconds'))`,
    );
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id, pid, last_heartbeat_at)
       VALUES ('inst-sibling', 'session-instance', '[]', datetime('now'), 'wf-inst', 4243, datetime('now'))`,
    );

    // Only the dead instance's pid is dead; the sibling's heartbeat is fresh.
    const result = sweepStaleAgentSessions(db, 60, (pid) => pid !== 4242);

    expect(result.orphanedIds).toEqual(["inst-dead"]);
    expect(getAgentSession(db, "inst-dead")?.status).toBe("orphaned");
    // The live sibling instance is NOT taken down by its sibling's orphaning.
    expect(getAgentSession(db, "inst-sibling")?.status).toBe("running");
    expect(getAgentSession(db, "inst-sibling")?.ended_at).toBeNull();
  });

  it("a supervisor with no workflow_id orphans without cascading (nothing to cascade)", () => {
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, pid, last_heartbeat_at)
       VALUES ('sup-nowf', 'sync-reviewers', '[]', datetime('now'), 4242, datetime('now','-300 seconds'))`,
    );
    const result = sweepStaleAgentSessions(db, 60, DEAD);
    expect(result.orphanedIds).toEqual(["sup-nowf"]);
    expect(getAgentSession(db, "sup-nowf")?.status).toBe("orphaned");
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

  it("is idempotent — a second sweep does not re-close or duplicate the event", () => {
    insertSession(db, {
      id: "stale-idem",
      branch: "feat/si",
      workflow_type: "review",
      session_dir: ".ocr/sessions/stale-idem",
    });
    db.run(
      `INSERT INTO orchestration_events
         (session_id, event_type, phase, phase_number, round, created_at)
       VALUES ('stale-idem', 'session_created', 'context', 1, 1, datetime('now', '-30 days'))`,
    );

    sweepStaleSessions(db, 7 * 24 * 60 * 60);
    const second = sweepStaleSessions(db, 7 * 24 * 60 * 60);

    // Already closed → not swept again; exactly one stale event.
    expect(second.closedSessionIds).not.toContain("stale-idem");
    const events = db.exec(
      `SELECT 1 FROM orchestration_events
        WHERE session_id = 'stale-idem' AND event_type = 'session_auto_closed_stale'`,
    );
    expect(events[0]?.values.length).toBe(1);
  });

  it("close is atomic — if the status UPDATE fails, the reason event rolls back (D1)", () => {
    // The transactional guarantee sweepStaleSessions/stateSync/reconcile all
    // rely on. Force the status UPDATE to abort (a temp trigger) and assert
    // the reason event inserted first inside the same transaction is gone.
    insertSession(db, {
      id: "boom",
      branch: "feat/boom",
      workflow_type: "review",
      session_dir: ".ocr/sessions/boom",
    });
    insertEvent(db, { session_id: "boom", event_type: "session_created", round: 1 });
    db.run(
      `CREATE TEMP TRIGGER trg_fail_boom BEFORE UPDATE OF status ON sessions
       WHEN NEW.id = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );

    expect(() =>
      commitReasonClose(
        db,
        "boom",
        { event_type: "session_auto_closed_stale", phase: "complete" },
        { status: "closed", current_phase: "complete" },
      ),
    ).toThrow();

    db.run("DROP TRIGGER trg_fail_boom");
    const orphan = db.exec(
      `SELECT 1 FROM orchestration_events
        WHERE session_id = 'boom' AND event_type = 'session_auto_closed_stale'`,
    );
    expect(orphan[0]?.values.length ?? 0).toBe(0); // rolled back — no orphan
    const status = db.exec("SELECT status FROM sessions WHERE id = 'boom'");
    expect(status[0]?.values[0]?.[0]).toBe("active"); // unchanged
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
