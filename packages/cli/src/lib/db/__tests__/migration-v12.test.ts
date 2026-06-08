import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
  ensureDatabase,
  closeAllDatabases,
  runMigrations,
  insertSession,
  insertEvent,
  updateSession,
  type Database,
} from "../index.js";

let tmpDir: string;
let db: Database;

async function freshDb(): Promise<Database> {
  tmpDir = mkdtempSync(join(tmpdir(), "ocr-v12-test-"));
  const conn = await openDatabase(join(tmpDir, "ocr.db"));
  runMigrations(conn);
  return conn;
}

beforeEach(async () => {
  db = await freshDb();
});

afterEach(() => {
  closeAllDatabases();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("migration v12 — event_type taxonomy guard", () => {
  beforeEach(() => {
    insertSession(db, {
      id: "s1",
      branch: "feat/x",
      workflow_type: "review",
      session_dir: ".ocr/sessions/s1",
    });
  });

  it("accepts a known event_type", () => {
    expect(() =>
      insertEvent(db, { session_id: "s1", event_type: "phase_transition" }),
    ).not.toThrow();
  });

  it("rejects an unknown event_type (typo protection)", () => {
    expect(() =>
      db.run(
        "INSERT INTO orchestration_events (session_id, event_type) VALUES (?, ?)",
        ["s1", "round_complete"], // missing 'd' — the classic typo
      ),
    ).toThrow(/unknown orchestration_events\.event_type/);
  });

  it("accepts the new v2 reason event types", () => {
    for (const t of [
      "session_aborted",
      "session_legacy_import",
      "session_auto_closed_stale",
    ]) {
      expect(() =>
        insertEvent(db, { session_id: "s1", event_type: t }),
      ).not.toThrow();
    }
  });
});

describe("migration v12 — session_completeness view", () => {
  function classify(sessionId: string): string {
    const r = db.exec(
      "SELECT completeness_state FROM session_completeness WHERE session_id = ?",
      [sessionId],
    );
    return r[0]?.values[0]?.[0] as string;
  }

  it("classifies a closed session with a round_completed as complete", () => {
    insertSession(db, {
      id: "done",
      branch: "feat/d",
      workflow_type: "review",
      session_dir: ".ocr/sessions/done",
    });
    insertEvent(db, {
      session_id: "done",
      event_type: "round_completed",
      round: 1,
    });
    updateSession(db, "done", { status: "closed" });
    expect(classify("done")).toBe("complete");
  });

  it("classifies a closed session without an artifact as closed_without_artifact", () => {
    // The "completed too soon" condition.
    insertSession(db, {
      id: "premature",
      branch: "feat/p",
      workflow_type: "review",
      session_dir: ".ocr/sessions/premature",
    });
    updateSession(db, "premature", { status: "closed" });
    expect(classify("premature")).toBe("closed_without_artifact");
  });

  it("classifies an open session with an in-flight dependent as in_flight", () => {
    insertSession(db, {
      id: "running",
      branch: "feat/r",
      workflow_type: "review",
      session_dir: ".ocr/sessions/running",
    });
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id, last_heartbeat_at)
       VALUES ('u1', 'review', '[]', datetime('now'), 'running', datetime('now'))`,
    );
    expect(classify("running")).toBe("in_flight");
  });

  it("classifies a bare open session as open_no_artifact", () => {
    insertSession(db, {
      id: "fresh",
      branch: "feat/f",
      workflow_type: "review",
      session_dir: ".ocr/sessions/fresh",
    });
    expect(classify("fresh")).toBe("open_no_artifact");
  });

  it("is the canonical detection for closed_without_artifact", () => {
    insertSession(db, {
      id: "bad",
      branch: "feat/b",
      workflow_type: "review",
      session_dir: ".ocr/sessions/bad",
    });
    updateSession(db, "bad", { status: "closed" });
    const rows = db.exec(
      "SELECT session_id FROM session_completeness WHERE completeness_state = 'closed_without_artifact'",
    );
    expect(rows[0]?.values.map((v) => v[0])).toContain("bad");
  });
});

describe("migration v12 — indexes", () => {
  it("creates the sweep indexes", () => {
    const idx = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_sessions_status','idx_events_session_created')",
    );
    const names = (idx[0]?.values ?? []).map((v) => v[0]);
    expect(names).toContain("idx_sessions_status");
    expect(names).toContain("idx_events_session_created");
  });
});

describe("migration v12 — pre-upgrade snapshot", () => {
  it("snapshots an existing pre-v12 database before upgrading", async () => {
    // Build a db, then simulate a pre-v12 state by removing the v12 row from
    // schema_version (the v12 DDL uses IF NOT EXISTS so re-applying is safe).
    const ocrDir = join(tmpDir, "proj", ".ocr");
    const dbPath = join(ocrDir, "data", "ocr.db");
    const conn = await ensureDatabase(ocrDir); // applies v12
    // Insert a row so the file is non-empty and worth snapshotting.
    insertSession(conn, {
      id: "keep",
      branch: "feat/k",
      workflow_type: "review",
      session_dir: ".ocr/sessions/keep",
    });
    conn.run("DELETE FROM schema_version WHERE version = 12");
    closeAllDatabases();

    // Re-open: getSchemaVersion now reports 11 → snapshot fires.
    await ensureDatabase(ocrDir);
    expect(existsSync(`${dbPath}.bak.v11`)).toBe(true);
  });
});
