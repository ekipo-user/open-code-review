import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import {
  openDatabase,
  closeAllDatabases,
  runMigrations,
  insertEvent,
  collectDbHealth,
  fixDb,
  vacuumDb,
  pruneDb,
  reapOrphanDbFiles,
  reapStaleExecLogs,
  type Database,
} from "../index.js";

let tmpDir: string;
let dataDir: string;
let dbPath: string;
let db: Database;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ocr-maint-test-"));
  dataDir = tmpDir; // dbPath's dirname — where temp/backup files live
  dbPath = join(dataDir, "ocr.db");
  db = await openDatabase(dbPath);
  runMigrations(db);
});

afterEach(() => {
  closeAllDatabases();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function count(sql: string): number {
  const r = db.exec(sql);
  return Number(r[0]?.values[0]?.[0] ?? 0);
}

function seedSession(id: string, status: "active" | "closed" = "closed"): void {
  db.run(
    `INSERT INTO sessions (id, branch, status, workflow_type, session_dir)
     VALUES (?, 'b', ?, 'review', ?)`,
    [id, status, `.ocr/sessions/${id}`],
  );
  insertEvent(db, {
    session_id: id,
    event_type: "session_created",
    phase: "context",
    phase_number: 1,
    round: 1,
  });
}

/** Insert child rows that reference non-existent parents — the sql.js-era
 *  pathology — by toggling FK enforcement off around the writes. */
function withForeignKeysOff(fn: () => void): void {
  db.pragma("foreign_keys = OFF");
  try {
    fn();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

describe("collectDbHealth", () => {
  it("reports a clean database with zero violations", () => {
    seedSession("s1");
    const h = collectDbHealth(db, dbPath);
    expect(h.integrityOk).toBe(true);
    expect(h.totalFkViolations).toBe(0);
    expect(h.markdownDuplicateRows).toBe(0);
    expect(h.sessionCount).toBe(1);
    expect(h.eventCount).toBe(1);
  });

  it("counts FK-orphan rows grouped by table, split into deletable vs protected", () => {
    seedSession("s1");
    withForeignKeysOff(() => {
      // Deletable cascade-artifact orphan: a round whose session is gone.
      db.run(
        "INSERT INTO review_rounds (session_id, round_number) VALUES ('ghost', 1)",
      );
      // Deeper orphan: a finding whose reviewer_output is also missing.
      db.run(
        "INSERT INTO reviewer_outputs (round_id, reviewer_type, file_path) VALUES (9999, 'principal', 'x.md')",
      );
      // Protected orphan: a command_executions row whose workflow is gone.
      db.run(
        `INSERT INTO command_executions (uid, command, args, started_at, workflow_id)
         VALUES ('u', 'review', '[]', datetime('now'), 'ghost')`,
      );
    });
    const h = collectDbHealth(db, dbPath);
    expect(h.totalFkViolations).toBeGreaterThanOrEqual(3);
    expect(h.fkViolations.map((g) => g.table).sort()).toContain("review_rounds");
    expect(h.protectedFkViolations.map((g) => g.table)).toContain(
      "command_executions",
    );
  });
});

describe("fixDb — FK-orphan sweep", () => {
  it("sweeps deletable orphans (incl. transitive), leaves events/sessions, integrity ok", () => {
    seedSession("keep");
    const eventsBefore = count("SELECT COUNT(*) FROM orchestration_events");
    const sessionsBefore = count("SELECT COUNT(*) FROM sessions");

    withForeignKeysOff(() => {
      // Orphan tree: round → output → finding, all rooted at a missing session.
      db.run(
        "INSERT INTO review_rounds (id, session_id, round_number) VALUES (500, 'ghost', 1)",
      );
      db.run(
        "INSERT INTO reviewer_outputs (id, round_id, reviewer_type, file_path) VALUES (600, 500, 'principal', 'x.md')",
      );
      db.run(
        "INSERT INTO review_findings (reviewer_output_id, title, severity) VALUES (600, 'bug', 'high')",
      );
      // Session-level orphan markdown.
      db.run(
        `INSERT INTO markdown_artifacts (session_id, artifact_type, round_number, file_path, content)
         VALUES ('ghost', 'context', NULL, 'ghost/context.md', 'x')`,
      );
    });
    expect(collectDbHealth(db, dbPath).totalFkViolations).toBeGreaterThan(0);

    const result = fixDb(db, dbPath, { snapshot: false });

    expect(result.fkViolationsAfter).toBe(0);
    expect(result.integrityOkAfter).toBe(true);
    expect(result.totalFkOrphansDeleted).toBeGreaterThanOrEqual(4);
    // The whole orphan tree is gone…
    expect(count("SELECT COUNT(*) FROM review_rounds")).toBe(0);
    expect(count("SELECT COUNT(*) FROM reviewer_outputs")).toBe(0);
    expect(count("SELECT COUNT(*) FROM review_findings")).toBe(0);
    expect(count("SELECT COUNT(*) FROM markdown_artifacts")).toBe(0);
    // …while the system of record is untouched.
    expect(count("SELECT COUNT(*) FROM orchestration_events")).toBe(eventsBefore);
    expect(count("SELECT COUNT(*) FROM sessions")).toBe(sessionsBefore);
  });

  it("never deletes a protected-table orphan; reports it for manual review", () => {
    seedSession("keep");
    withForeignKeysOff(() => {
      db.run(
        `INSERT INTO command_executions (uid, command, args, started_at, workflow_id)
         VALUES ('u', 'review', '[]', datetime('now'), 'ghost')`,
      );
    });

    const result = fixDb(db, dbPath, { snapshot: false });

    // The orphan row survives — protected tables are the system of record.
    expect(count("SELECT COUNT(*) FROM command_executions")).toBe(1);
    expect(
      result.protectedViolationsRemaining.map((g) => g.table),
    ).toContain("command_executions");
    expect(result.fkViolationsAfter).toBeGreaterThan(0);
  });

  it("writes a snapshot when requested", () => {
    seedSession("s1");
    const result = fixDb(db, dbPath, { snapshot: true, vacuum: false });
    expect(result.snapshotPath).not.toBeNull();
    expect(existsSync(result.snapshotPath!)).toBe(true);
  });
});

describe("fixDb — markdown dedup", () => {
  it("collapses duplicate NULL-round rows that predate the unique index", () => {
    seedSession("s1");
    // Regress the v14 index so the legacy duplication is reproducible.
    db.run("DROP INDEX IF EXISTS idx_markdown_artifacts_logical");
    for (const c of ["a", "b", "c-latest"]) {
      db.run(
        `INSERT INTO markdown_artifacts (session_id, artifact_type, round_number, file_path, content)
         VALUES ('s1', 'context', NULL, 's1/context.md', ?)`,
        [c],
      );
    }
    expect(count("SELECT COUNT(*) FROM markdown_artifacts")).toBe(3);

    const result = fixDb(db, dbPath, { snapshot: false });

    expect(result.markdownDupsDeleted).toBe(2);
    expect(count("SELECT COUNT(*) FROM markdown_artifacts")).toBe(1);
    expect(db.exec("SELECT content FROM markdown_artifacts")[0]!.values[0]![0]).toBe(
      "c-latest",
    );
  });
});

describe("reapOrphanDbFiles", () => {
  it("reaps a dead-PID, old temp file and leaves the live DB set alone", () => {
    const orphan = join(dataDir, "ocr.db.999999.tmp"); // PID 999999 is not alive
    writeFileSync(orphan, "stale");
    const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;
    utimesSync(orphan, twoHoursAgo, twoHoursAgo);

    const reaped = reapOrphanDbFiles(dataDir);

    expect(reaped).toContain("ocr.db.999999.tmp");
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(dbPath)).toBe(true); // live DB untouched
  });

  it("does not reap a recent temp file (could be a live mid-write)", () => {
    const recent = join(dataDir, "ocr.db.999998.tmp");
    writeFileSync(recent, "fresh"); // mtime = now → not reapable
    const reaped = reapOrphanDbFiles(dataDir);
    expect(reaped).not.toContain("ocr.db.999998.tmp");
    expect(existsSync(recent)).toBe(true);
  });
});

describe("reapStaleExecLogs", () => {
  it("removes logs older than the window and keeps recent ones", () => {
    const logsDir = join(dataDir, "exec-logs");
    mkdirSync(logsDir, { recursive: true });
    const stale = join(logsDir, "old-uid.log");
    const fresh = join(logsDir, "new-uid.log");
    writeFileSync(stale, "old run");
    writeFileSync(fresh, "current run");
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 60 * 60;
    utimesSync(stale, eightDaysAgo, eightDaysAgo);

    const reaped = reapStaleExecLogs(logsDir);

    expect(reaped).toEqual(["old-uid.log"]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("returns [] when the exec-logs dir does not exist", () => {
    expect(reapStaleExecLogs(join(dataDir, "nope"))).toEqual([]);
  });
});

describe("vacuumDb", () => {
  it("reclaims space after a large delete and keeps integrity", () => {
    seedSession("s1");
    for (let i = 0; i < 500; i++) {
      db.run(
        `INSERT INTO markdown_artifacts (session_id, artifact_type, round_number, file_path, content)
         VALUES ('s1', 'blob', ?, ?, ?)`,
        [i, `s1/blob-${i}.md`, "x".repeat(2000)],
      );
    }
    db.run("DELETE FROM markdown_artifacts");

    const result = vacuumDb(db, dbPath, { snapshot: false });

    expect(result.sizeAfterBytes).toBeLessThanOrEqual(result.sizeBeforeBytes);
    expect(collectDbHealth(db, dbPath).integrityOk).toBe(true);
  });
});

describe("pruneDb", () => {
  function seedClosedWithArtifacts(id: string, ageDays: number): void {
    seedSession(id, "closed");
    db.run(
      "INSERT INTO review_rounds (session_id, round_number) VALUES (?, 1)",
      [id],
    );
    db.run(
      `INSERT INTO markdown_artifacts (session_id, artifact_type, round_number, file_path, content)
       VALUES (?, 'final', 1, ?, 'body')`,
      [id, `${id}/final.md`],
    );
    if (ageDays > 0) {
      db.run(
        `UPDATE orchestration_events SET created_at = datetime('now', ?) WHERE session_id = ?`,
        [`-${ageDays} days`, id],
      );
    }
  }

  it("prunes only old closed sessions; keeps events + the session row", () => {
    seedClosedWithArtifacts("old", 30);
    seedClosedWithArtifacts("recent", 0);
    const eventsBefore = count("SELECT COUNT(*) FROM orchestration_events");

    const result = pruneDb(db, dbPath, { olderThanDays: 7 });

    expect(result.prunedSessions.map((p) => p.sessionId)).toEqual(["old"]);
    // Old session's artifacts gone…
    expect(count("SELECT COUNT(*) FROM review_rounds WHERE session_id='old'")).toBe(0);
    expect(count("SELECT COUNT(*) FROM markdown_artifacts WHERE session_id='old'")).toBe(0);
    // …recent session's artifacts intact…
    expect(count("SELECT COUNT(*) FROM review_rounds WHERE session_id='recent'")).toBe(1);
    // …and events + both session rows are preserved.
    expect(count("SELECT COUNT(*) FROM orchestration_events")).toBe(eventsBefore);
    expect(count("SELECT COUNT(*) FROM sessions")).toBe(2);
  });

  it("--keep-sessions protects the N most-recently-active closed sessions", () => {
    seedClosedWithArtifacts("oldest", 30);
    seedClosedWithArtifacts("middle", 20);
    seedClosedWithArtifacts("newest", 10);

    // Keep the 1 most recent (newest); prune the rest that are also >7d old.
    const result = pruneDb(db, dbPath, { keepSessions: 1, olderThanDays: 7 });

    expect(result.prunedSessions.map((p) => p.sessionId).sort()).toEqual([
      "middle",
      "oldest",
    ]);
    expect(count("SELECT COUNT(*) FROM review_rounds WHERE session_id='newest'")).toBe(1);
  });

  it("dry-run reports the plan without deleting", () => {
    seedClosedWithArtifacts("old", 30);
    const result = pruneDb(db, dbPath, { olderThanDays: 7, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.prunedSessions.map((p) => p.sessionId)).toEqual(["old"]);
    expect(result.snapshotPath).toBeNull();
    expect(count("SELECT COUNT(*) FROM review_rounds WHERE session_id='old'")).toBe(1);
  });

  it("does nothing without a bound", () => {
    seedClosedWithArtifacts("old", 30);
    const result = pruneDb(db, dbPath, {});
    expect(result.prunedSessions).toEqual([]);
    expect(count("SELECT COUNT(*) FROM review_rounds WHERE session_id='old'")).toBe(1);
  });

  it("never prunes an active session even if old", () => {
    seedSession("active-old", "active");
    db.run("INSERT INTO review_rounds (session_id, round_number) VALUES ('active-old', 1)");
    db.run(
      "UPDATE orchestration_events SET created_at = datetime('now','-30 days') WHERE session_id='active-old'",
    );
    const result = pruneDb(db, dbPath, { olderThanDays: 7 });
    expect(result.prunedSessions).toEqual([]);
    expect(count("SELECT COUNT(*) FROM review_rounds WHERE session_id='active-old'")).toBe(1);
  });
});
