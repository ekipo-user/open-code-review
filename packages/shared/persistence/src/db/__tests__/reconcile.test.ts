import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
  runMigrations,
  insertSession,
  insertEvent,
  updateSession,
  reconcileLegacyState,
  type Database,
} from "../index.js";
import { makeTempWorkspace, removeTempWorkspace } from "../test-support.js";

let tmpDir: string;
let ocrDir: string;
let db: Database;

beforeEach(async () => {
  tmpDir = makeTempWorkspace("ocr-reconcile-");
  ocrDir = join(tmpDir, ".ocr");
  mkdirSync(join(ocrDir, "data"), { recursive: true });
  db = await openDatabase(join(ocrDir, "data", "ocr.db"));
  runMigrations(db);
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
});

/** Seed a session and write its session_dir as a project-relative path. */
function seed(
  id: string,
  status: "active" | "closed",
  opts: { workflow_type?: "review" | "map"; round?: number; mapRun?: number } = {},
): string {
  const sessionDir = join(".ocr", "sessions", id);
  const wf = opts.workflow_type ?? "review";
  if (status === "closed") {
    // Simulate a legacy pre-trigger row: closed without a terminal/reason
    // event (the exact "completed too soon" state reconcile must heal).
    // Direct INSERT bypasses the close-guard, which only governs the
    // active → closed UPDATE transition, not fixture creation.
    db.run(
      `INSERT INTO sessions
         (id, branch, status, workflow_type, current_phase, phase_number, current_round, current_map_run, session_dir)
       VALUES (?, 'feat/x', 'closed', ?, 'complete', 8, ?, ?, ?)`,
      [id, wf, opts.round ?? 1, opts.mapRun ?? 1, sessionDir],
    );
    insertEvent(db, { session_id: id, event_type: "session_created", round: 1 });
  } else {
    insertSession(db, {
      id,
      branch: "feat/x",
      workflow_type: wf,
      session_dir: sessionDir,
    });
    // Mirror stateInit: every real session has a session_created event.
    insertEvent(db, { session_id: id, event_type: "session_created", round: 1 });
    if (opts.round) updateSession(db, id, { current_round: opts.round });
    if (opts.mapRun) updateSession(db, id, { current_map_run: opts.mapRun });
  }
  return join(tmpDir, sessionDir);
}

function completenessState(id: string): string {
  const r = db.exec(
    "SELECT completeness_state FROM session_completeness WHERE session_id = ?",
    [id],
  );
  return r[0]?.values[0]?.[0] as string;
}

describe("reconcileLegacyState", () => {
  it("synthesizes round_completed from a provable final.md", () => {
    const dir = seed("syn", "closed", { round: 2 });
    mkdirSync(join(dir, "rounds", "round-2"), { recursive: true });
    writeFileSync(join(dir, "rounds", "round-2", "final.md"), "# Final\n");

    expect(completenessState("syn")).toBe("closed_without_artifact");
    const res = reconcileLegacyState(db, ocrDir);
    expect(res.actions.find((a) => a.sessionId === "syn")?.kind).toBe(
      "synthesize-round-completed",
    );
    expect(completenessState("syn")).toBe("complete");
  });

  it("synthesizes map_completed from a provable map.md", () => {
    const dir = seed("synmap", "closed", { workflow_type: "map", mapRun: 1 });
    mkdirSync(join(dir, "map", "runs", "run-1"), { recursive: true });
    writeFileSync(join(dir, "map", "runs", "run-1", "map.md"), "# Map\n");

    const res = reconcileLegacyState(db, ocrDir);
    expect(res.actions.find((a) => a.sessionId === "synmap")?.kind).toBe(
      "synthesize-map-completed",
    );
    expect(completenessState("synmap")).toBe("complete");
  });

  it("grandfathers a closed session with no provable artifact", () => {
    seed("grand", "closed");
    const res = reconcileLegacyState(db, ocrDir);
    expect(res.actions.find((a) => a.sessionId === "grand")?.kind).toBe("grandfather");
    // Still closed, but now carries a reason event so it's not an anomaly.
    const ev = db.exec(
      "SELECT 1 FROM orchestration_events WHERE session_id = 'grand' AND event_type = 'session_legacy_import'",
    );
    expect(ev[0]?.values.length).toBe(1);
  });

  it("stale-closes an active session with no recent events and no dependents", () => {
    seed("stale", "active");
    // Backdate the only event to look ancient.
    db.run(
      "UPDATE orchestration_events SET created_at = datetime('now','-30 days') WHERE session_id = 'stale'",
    );
    const res = reconcileLegacyState(db, ocrDir);
    expect(res.actions.find((a) => a.sessionId === "stale")?.kind).toBe("stale-close");
    const status = db.exec("SELECT status FROM sessions WHERE id = 'stale'");
    expect(status[0]?.values[0]?.[0]).toBe("closed");
    // Wrote the reason event BEFORE the close (close-guard forward-compat).
    const ev = db.exec(
      "SELECT 1 FROM orchestration_events WHERE session_id = 'stale' AND event_type = 'session_auto_closed_stale'",
    );
    expect(ev[0]?.values.length).toBe(1);
  });

  it("leaves a recently-active session untouched", () => {
    seed("live", "active"); // session_created event is 'now'
    const res = reconcileLegacyState(db, ocrDir);
    expect(res.actions.find((a) => a.sessionId === "live")).toBeUndefined();
    const status = db.exec("SELECT status FROM sessions WHERE id = 'live'");
    expect(status[0]?.values[0]?.[0]).toBe("active");
  });

  it("does not close an active session that has in-flight dependents", () => {
    seed("busy", "active");
    db.run(
      "UPDATE orchestration_events SET created_at = datetime('now','-30 days') WHERE session_id = 'busy'",
    );
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id)
       VALUES ('u', 'review', '[]', datetime('now'), 'busy')`,
    );
    const res = reconcileLegacyState(db, ocrDir);
    expect(res.actions.find((a) => a.sessionId === "busy")).toBeUndefined();
  });

  it("dry-run reports the plan without writing", () => {
    seed("dry", "closed");
    const res = reconcileLegacyState(db, ocrDir, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.actions.find((a) => a.sessionId === "dry")?.kind).toBe("grandfather");
    const ev = db.exec(
      "SELECT 1 FROM orchestration_events WHERE session_id = 'dry' AND event_type = 'session_legacy_import'",
    );
    expect(ev[0]?.values.length ?? 0).toBe(0); // nothing written
  });

  it("is idempotent — a second run makes no further changes", () => {
    seed("idem", "closed");
    const first = reconcileLegacyState(db, ocrDir);
    expect(first.actions.some((a) => a.kind !== "ok")).toBe(true);
    const second = reconcileLegacyState(db, ocrDir);
    expect(second.actions.some((a) => a.kind !== "ok")).toBe(false);
  });
});
