import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
  ensureDatabase,
  closeAllDatabases,
  insertSession,
  updateSession,
  getSession,
  getLatestActiveSession,
  getAllSessions,
  insertEvent,
  getEventsForSession,
  getLatestEventId,
} from "../index.js";
import { makeTempWorkspace, removeTempWorkspace } from "../test-support.js";
import { runMigrations, MIGRATIONS } from "../migrations.js";
import type { Database } from "../engine.js";

let tmpDir: string;
let db: Database;
let dbPath: string;

beforeEach(async () => {
  tmpDir = makeTempWorkspace("ocr-db-test-");
  dbPath = join(tmpDir, "test.db");
  db = await openDatabase(dbPath);
  runMigrations(db);
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
});

describe("Database creation and migration", () => {
  it("creates a new database and applies migrations", () => {
    const result = db.exec(
      "SELECT version, description FROM schema_version ORDER BY version",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.values).toHaveLength(MIGRATIONS.length);
    expect(result[0]?.values[0]?.[0]).toBe(1);
  });

  it("creates all expected tables", () => {
    const result = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    expect(result).toHaveLength(1);
    const tableNames = result[0]?.values.map((row) => row[0]) ?? [];

    const expectedTables = [
      "command_executions",
      "map_files",
      "map_runs",
      "map_sections",
      "markdown_artifacts",
      "orchestration_events",
      "review_findings",
      "review_rounds",
      "reviewer_outputs",
      "schema_version",
      "sessions",
      "user_file_progress",
      "user_finding_progress",
      "user_notes",
    ];

    for (const table of expectedTables) {
      expect(tableNames).toContain(table);
    }
  });

  it("does not re-run already applied migrations", () => {
    const beforeCount = db.exec("SELECT COUNT(*) FROM schema_version")[0]
      ?.values[0]?.[0] as number;

    // Run migrations again — should be a no-op
    runMigrations(db);

    const afterCount = db.exec("SELECT COUNT(*) FROM schema_version")[0]
      ?.values[0]?.[0] as number;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("Schema version tracking", () => {
  it("records the applied migration version", () => {
    const result = db.exec(
      "SELECT version, description FROM schema_version WHERE version = 1",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.values[0]?.[0]).toBe(1);
    expect(result[0]?.values[0]?.[1]).toContain("Initial schema");
  });

  it("records applied_at timestamp", () => {
    const result = db.exec(
      "SELECT applied_at FROM schema_version WHERE version = 1",
    );
    expect(result).toHaveLength(1);
    const appliedAt = result[0]?.values[0]?.[0] as string;
    expect(appliedAt).toBeTruthy();
    // Should be a valid datetime string
    expect(new Date(appliedAt).toString()).not.toBe("Invalid Date");
  });
});

describe("Pragma verification", () => {
  it("enables foreign keys", () => {
    const result = db.exec("PRAGMA foreign_keys");
    expect(result[0]?.values[0]?.[0]).toBe(1);
  });
});

describe("Session CRUD", () => {
  it("inserts and retrieves a session", () => {
    insertSession(db, {
      id: "test-session-1",
      branch: "feat/test",
      workflow_type: "review",
      session_dir: "/tmp/ocr/sessions/test-session-1",
    });

    const session = getSession(db, "test-session-1");
    expect(session).toBeDefined();
    expect(session?.id).toBe("test-session-1");
    expect(session?.branch).toBe("feat/test");
    expect(session?.workflow_type).toBe("review");
    expect(session?.status).toBe("active");
    expect(session?.current_phase).toBe("context");
    expect(session?.phase_number).toBe(1);
    expect(session?.current_round).toBe(1);
    expect(session?.current_map_run).toBe(1);
  });

  it("updates a session", () => {
    insertSession(db, {
      id: "test-session-2",
      branch: "feat/update",
      workflow_type: "review",
      session_dir: "/tmp/ocr/sessions/test-session-2",
    });

    // A reason event makes the close-guard trigger permit the close.
    insertEvent(db, { session_id: "test-session-2", event_type: "session_synced" });
    updateSession(db, "test-session-2", {
      status: "closed",
      current_phase: "synthesis",
      phase_number: 7,
    });

    const session = getSession(db, "test-session-2");
    expect(session?.status).toBe("closed");
    expect(session?.current_phase).toBe("synthesis");
    expect(session?.phase_number).toBe(7);
  });

  it("returns undefined for non-existent session", () => {
    const session = getSession(db, "non-existent");
    expect(session).toBeUndefined();
  });

  it("gets the latest active session", () => {
    insertSession(db, {
      id: "old-session",
      branch: "feat/old",
      workflow_type: "review",
      session_dir: "/tmp/ocr/sessions/old-session",
    });

    insertSession(db, {
      id: "new-session",
      branch: "feat/new",
      workflow_type: "map",
      session_dir: "/tmp/ocr/sessions/new-session",
    });

    const latest = getLatestActiveSession(db);
    expect(latest).toBeDefined();
    // Both have the same started_at (datetime('now') within same second),
    // so either could be returned. Just verify we get an active session.
    expect(latest?.status).toBe("active");
  });

  it("returns undefined when no active sessions exist", () => {
    insertSession(db, {
      id: "closed-session",
      branch: "feat/closed",
      workflow_type: "review",
      session_dir: "/tmp/ocr/sessions/closed-session",
    });
    insertEvent(db, { session_id: "closed-session", event_type: "session_synced" });
    updateSession(db, "closed-session", { status: "closed" });

    const latest = getLatestActiveSession(db);
    expect(latest).toBeUndefined();
  });

  it("gets all sessions", () => {
    insertSession(db, {
      id: "s1",
      branch: "feat/a",
      workflow_type: "review",
      session_dir: "/tmp/ocr/sessions/s1",
    });
    insertSession(db, {
      id: "s2",
      branch: "feat/b",
      workflow_type: "map",
      session_dir: "/tmp/ocr/sessions/s2",
    });

    const sessions = getAllSessions(db);
    expect(sessions).toHaveLength(2);
  });
});

describe("Event insertion and querying", () => {
  it("inserts and retrieves events for a session", () => {
    insertSession(db, {
      id: "event-session",
      branch: "feat/events",
      workflow_type: "review",
      session_dir: "/tmp/ocr/sessions/event-session",
    });

    insertEvent(db, {
      session_id: "event-session",
      event_type: "phase_transition",
      phase: "context",
      phase_number: 1,
      round: 1,
    });

    insertEvent(db, {
      session_id: "event-session",
      event_type: "round_completed",
      phase: "context",
      phase_number: 1,
      round: 1,
      metadata: JSON.stringify({ duration_ms: 1200 }),
    });

    const events = getEventsForSession(db, "event-session");
    expect(events).toHaveLength(2);
    expect(events[0]?.event_type).toBe("phase_transition");
    expect(events[1]?.event_type).toBe("round_completed");
    expect(events[1]?.metadata).toBe('{"duration_ms":1200}');
  });

  it("returns empty array for session with no events", () => {
    insertSession(db, {
      id: "no-events",
      branch: "feat/empty",
      workflow_type: "review",
      session_dir: "/tmp/ocr/sessions/no-events",
    });

    const events = getEventsForSession(db, "no-events");
    expect(events).toHaveLength(0);
  });

  it("gets the latest event ID", () => {
    insertSession(db, {
      id: "event-id-session",
      branch: "feat/id",
      workflow_type: "review",
      session_dir: "/tmp/ocr/sessions/event-id-session",
    });

    expect(getLatestEventId(db)).toBe(0);

    insertEvent(db, {
      session_id: "event-id-session",
      event_type: "phase_transition",
    });

    const latestId = getLatestEventId(db);
    expect(latestId).toBeGreaterThan(0);
  });
});

describe("ensureDatabase", () => {
  it("creates the data directory and database file", async () => {
    // Not teardown — simulating a process restart before re-opening the DB.
    // Keep: this is an intentional mid-test drain, not a stray SF3 leftover.
    closeAllDatabases();
    const ocrDir = join(tmpDir, "ocr-project", ".ocr");
    const ensuredDb = await ensureDatabase(ocrDir);

    expect(ensuredDb).toBeDefined();
    expect(existsSync(join(ocrDir, "data", "ocr.db"))).toBe(true);

    // Verify migrations ran (v1 + v2)
    const result = ensuredDb.exec("SELECT COUNT(*) FROM schema_version");
    expect(result[0]?.values[0]?.[0]).toBeGreaterThanOrEqual(1);

    ensuredDb.close();
  });
});

describe("Foreign key constraints", () => {
  it("enforces foreign key on orchestration_events", () => {
    expect(() => {
      db.run(
        `INSERT INTO orchestration_events (session_id, event_type)
         VALUES ('nonexistent', 'test')`,
      );
    }).toThrow();
  });
});
