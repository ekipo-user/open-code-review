import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  openDatabase,
  ensureDatabase,
  closeAllDatabases,
  runMigrations,
  insertSession,
  insertEvent,
  updateSession,
  formatUpgradeNotice,
  type Database,
} from "../index.js";
import { makeTempWorkspace, removeTempWorkspace } from "../test-support.js";

let tmpDir: string;
let db: Database;

async function freshDb(): Promise<Database> {
  tmpDir = makeTempWorkspace("ocr-v12-test-");
  const conn = await openDatabase(join(tmpDir, "ocr.db"));
  runMigrations(conn);
  return conn;
}

beforeEach(async () => {
  db = await freshDb();
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
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
    // The "completed too soon" condition — a legacy pre-trigger row,
    // created via direct INSERT (the close-guard governs UPDATEs, not
    // fixture inserts).
    db.run(
      `INSERT INTO sessions (id, branch, status, workflow_type, current_phase, phase_number, current_round, current_map_run, session_dir)
       VALUES ('premature', 'feat/p', 'closed', 'review', 'complete', 8, 1, 1, '.ocr/sessions/premature')`,
    );
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
    db.run(
      `INSERT INTO sessions (id, branch, status, workflow_type, current_phase, phase_number, current_round, current_map_run, session_dir)
       VALUES ('bad', 'feat/b', 'closed', 'review', 'complete', 8, 1, 1, '.ocr/sessions/bad')`,
    );
    const rows = db.exec(
      "SELECT session_id FROM session_completeness WHERE completeness_state = 'closed_without_artifact'",
    );
    expect(rows[0]?.values.map((v) => v[0])).toContain("bad");
  });
});

describe("migration v12 — close-guard trigger (DB backstop)", () => {
  // Reproduces the production "completed too soon" mechanism from
  // 2026-05-16-hotfix-super-admin: a workflow at 'synthesis' is closed with
  // no round_completed event. The trigger must abort it even via raw SQL.
  beforeEach(() => {
    insertSession(db, {
      id: "g",
      branch: "feat/g",
      workflow_type: "review",
      session_dir: ".ocr/sessions/g",
    });
    insertEvent(db, { session_id: "g", event_type: "session_created", round: 1 });
    updateSession(db, "g", { current_phase: "synthesis", phase_number: 7 });
  });

  it("aborts a raw close of a session with no completed round", () => {
    expect(() =>
      db.run("UPDATE sessions SET status = 'closed' WHERE id = 'g'"),
    ).toThrow(/cannot close session without a completed round/);
    // The session stays open — the illegal state was never written.
    const r = db.exec("SELECT status FROM sessions WHERE id = 'g'");
    expect(r[0]?.values[0]?.[0]).toBe("active");
  });

  it("permits the close once the round is completed (legitimate path)", () => {
    insertEvent(db, { session_id: "g", event_type: "round_completed", round: 1 });
    expect(() =>
      db.run("UPDATE sessions SET status = 'closed' WHERE id = 'g'"),
    ).not.toThrow();
  });

  it("permits the close when an explicit reason event is present (abort/sync/stale)", () => {
    insertEvent(db, { session_id: "g", event_type: "session_aborted", round: 1 });
    expect(() =>
      db.run("UPDATE sessions SET status = 'closed' WHERE id = 'g'"),
    ).not.toThrow();
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
    // Build a db, then simulate a pre-v12 state by removing the v12-and-later
    // rows from schema_version (the v12 DDL uses IF NOT EXISTS so re-applying
    // is safe), so getSchemaVersion reports 11.
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
    conn.run("DELETE FROM schema_version WHERE version >= 12");
    // Not teardown — simulating a process restart so the re-open re-runs
    // migrations. Intentional mid-test drain, not a stray SF3 leftover.
    closeAllDatabases();

    // Re-open: getSchemaVersion now reports 11 → snapshot fires.
    await ensureDatabase(ocrDir);
    expect(existsSync(`${dbPath}.bak.v11`)).toBe(true);
  });
});

describe("migration v12 — one-time upgrade notice", () => {
  it("formats the notice with backup path + reconciliation summary", () => {
    const notice = formatUpgradeNotice("/p/.ocr/data/ocr.db.bak.v11", {
      dryRun: false,
      actions: [
        { sessionId: "a", kind: "synthesize-round-completed", detail: "" },
        { sessionId: "b", kind: "grandfather", detail: "" },
        { sessionId: "c", kind: "stale-close", detail: "" },
        { sessionId: "d", kind: "ok", detail: "" },
      ],
    });
    expect(notice).toContain("Storage upgraded to v2.0");
    expect(notice).toContain("ocr.db.bak.v11");
    expect(notice).toContain("Reconciled 3 legacy session(s)");
    expect(notice).toContain("1 finalized from artifacts");
    expect(notice).toContain("1 grandfathered");
    expect(notice).toContain("1 stale closed");
    // STDERR-only convention: each line is prefixed for grep-ability.
    for (const line of notice!.split("\n")) expect(line.startsWith("[ocr] ")).toBe(true);
  });

  it("omits the reconciliation line when nothing needed repair", () => {
    const notice = formatUpgradeNotice("/p/ocr.db.bak.v11", { dryRun: false, actions: [] });
    expect(notice).toContain("Storage upgraded to v2.0");
    expect(notice).not.toContain("Reconciled");
  });

  it("emits the notice once on a real upgrade, and never for a brand-new install", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Brand-new install (version 0 → v12): NO upgrade notice.
      const freshDir = join(tmpDir, "fresh", ".ocr");
      await ensureDatabase(freshDir);
      expect(
        errSpy.mock.calls.flat().some((a) => String(a).includes("Storage upgraded to v2.0")),
      ).toBe(false);

      // Existing pre-v12 db → upgrade notice fires.
      const ocrDir = join(tmpDir, "legacy", ".ocr");
      const conn = await ensureDatabase(ocrDir);
      conn.run("DELETE FROM schema_version WHERE version >= 12");
      // Not teardown — simulating a process restart so the next ensureDatabase
      // sees version 11 and emits the upgrade notice. Intentional mid-test drain.
      closeAllDatabases();
      errSpy.mockClear();

      await ensureDatabase(ocrDir); // before = 11 → notice
      const emitted = errSpy.mock.calls
        .flat()
        .filter((a) => String(a).includes("Storage upgraded to v2.0"));
      expect(emitted.length).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
