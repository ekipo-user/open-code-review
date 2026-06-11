/**
 * Schema migration runner for the OCR SQLite database.
 */

import type { Database } from "./engine.js";
import type { Migration } from "./types.js";

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema — sessions, events, artifacts, user state",
    sql: `
      -- Layer 1: Workflow State

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        branch TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed')),
        workflow_type TEXT NOT NULL CHECK(workflow_type IN ('review', 'map')),
        current_phase TEXT NOT NULL DEFAULT 'context',
        phase_number INTEGER NOT NULL DEFAULT 1,
        current_round INTEGER NOT NULL DEFAULT 1,
        current_map_run INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        session_dir TEXT NOT NULL
      );

      CREATE TABLE orchestration_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        phase TEXT,
        phase_number INTEGER,
        round INTEGER,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_events_session ON orchestration_events(session_id);
      CREATE INDEX idx_events_type ON orchestration_events(event_type);

      -- Layer 2: Artifacts

      CREATE TABLE review_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL,
        verdict TEXT,
        blocker_count INTEGER DEFAULT 0,
        suggestion_count INTEGER DEFAULT 0,
        should_fix_count INTEGER DEFAULT 0,
        final_md_path TEXT,
        parsed_at TEXT,
        UNIQUE(session_id, round_number)
      );

      CREATE TABLE reviewer_outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
        reviewer_type TEXT NOT NULL,
        instance_number INTEGER NOT NULL DEFAULT 1,
        file_path TEXT NOT NULL,
        finding_count INTEGER DEFAULT 0,
        parsed_at TEXT,
        UNIQUE(round_id, reviewer_type, instance_number)
      );

      CREATE TABLE review_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reviewer_output_id INTEGER NOT NULL REFERENCES reviewer_outputs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('critical', 'high', 'medium', 'low', 'info')),
        file_path TEXT,
        line_start INTEGER,
        line_end INTEGER,
        summary TEXT,
        is_blocker INTEGER NOT NULL DEFAULT 0,
        parsed_at TEXT
      );
      CREATE INDEX idx_findings_severity ON review_findings(severity);

      CREATE TABLE markdown_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL,
        round_number INTEGER,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        parsed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, artifact_type, round_number, file_path)
      );

      CREATE TABLE map_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_number INTEGER NOT NULL,
        file_count INTEGER DEFAULT 0,
        map_md_path TEXT,
        parsed_at TEXT,
        UNIQUE(session_id, run_number)
      );

      CREATE TABLE map_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        map_run_id INTEGER NOT NULL REFERENCES map_runs(id) ON DELETE CASCADE,
        section_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        file_count INTEGER DEFAULT 0,
        display_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE(map_run_id, section_number)
      );

      CREATE TABLE map_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        section_id INTEGER NOT NULL REFERENCES map_sections(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        role TEXT,
        lines_added INTEGER DEFAULT 0,
        lines_deleted INTEGER DEFAULT 0,
        display_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE(section_id, file_path)
      );

      -- Layer 3: User Interaction

      CREATE TABLE user_file_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        map_file_id INTEGER NOT NULL REFERENCES map_files(id) ON DELETE CASCADE,
        is_reviewed INTEGER NOT NULL DEFAULT 0,
        reviewed_at TEXT,
        UNIQUE(map_file_id)
      );

      CREATE TABLE user_finding_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id INTEGER NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'unread' CHECK(status IN ('unread', 'read', 'acknowledged', 'fixed', 'wont_fix')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(finding_id)
      );

      CREATE TABLE user_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL CHECK(target_type IN ('session', 'round', 'finding', 'run', 'section', 'file')),
        target_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE command_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        args TEXT,
        exit_code INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        output TEXT
      );
    `,
  },
  {
    version: 2,
    description: "Add chat conversations, messages, and round progress tables",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK(target_type IN ('map_run', 'review_round')),
        target_id INTEGER NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS user_round_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'needs_review'
          CHECK(status IN ('needs_review', 'in_progress', 'changes_made', 'acknowledged', 'dismissed')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(round_id)
      );
    `,
  },
  {
    version: 3,
    description: "Add PID tracking to command_executions for orphan process cleanup",
    sql: `
      ALTER TABLE command_executions ADD COLUMN pid INTEGER;
    `,
  },
  {
    version: 4,
    description: "Add is_detached flag to command_executions for process group kill strategy",
    sql: `
      ALTER TABLE command_executions ADD COLUMN is_detached INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 5,
    description: "Change orchestration_events FK to RESTRICT to protect audit trail",
    sql: `
      CREATE TABLE orchestration_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        phase TEXT,
        phase_number INTEGER,
        round INTEGER,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO orchestration_events_new SELECT * FROM orchestration_events;
      DROP TABLE orchestration_events;
      ALTER TABLE orchestration_events_new RENAME TO orchestration_events;
      CREATE INDEX idx_events_session ON orchestration_events(session_id);
      CREATE INDEX idx_events_type ON orchestration_events(event_type);
    `,
  },
  {
    version: 6,
    description: "Add orchestrator-first columns to review_rounds for round-meta.json support",
    sql: `
      ALTER TABLE review_rounds ADD COLUMN source TEXT DEFAULT NULL;
      ALTER TABLE review_rounds ADD COLUMN reviewer_count INTEGER DEFAULT 0;
      ALTER TABLE review_rounds ADD COLUMN total_finding_count INTEGER DEFAULT 0;
    `,
  },
  {
    version: 7,
    description: "Add category column to review_findings for blocker/should_fix/suggestion classification",
    sql: `
      ALTER TABLE review_findings ADD COLUMN category TEXT DEFAULT NULL;
    `,
  },
  {
    version: 8,
    description: "Add orchestrator-first columns to map_runs for map-meta.json support",
    sql: `
      ALTER TABLE map_runs ADD COLUMN source TEXT DEFAULT NULL;
      ALTER TABLE map_runs ADD COLUMN section_count INTEGER DEFAULT 0;
    `,
  },
  {
    version: 9,
    description: "Add uid column to command_executions for JSONL-backed recovery",
    sql: `
      ALTER TABLE command_executions ADD COLUMN uid TEXT;
      CREATE UNIQUE INDEX idx_command_executions_uid ON command_executions(uid);
    `,
  },
  {
    version: 10,
    description: "Add agent_sessions journal for per-instance lifecycle tracking",
    sql: `
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        vendor TEXT NOT NULL,
        vendor_session_id TEXT,
        persona TEXT,
        instance_index INTEGER,
        name TEXT,
        resolved_model TEXT,
        phase TEXT,
        status TEXT NOT NULL CHECK(status IN ('spawning', 'running', 'done', 'crashed', 'cancelled', 'orphaned')),
        pid INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        exit_code INTEGER,
        notes TEXT
      );
      CREATE INDEX idx_agent_sessions_workflow ON agent_sessions(workflow_id);
      CREATE INDEX idx_agent_sessions_status_heartbeat ON agent_sessions(status, last_heartbeat_at);
    `,
  },
  {
    version: 11,
    description:
      "Unify agent_sessions into command_executions — every spawned process is one execution row",
    sql: `
      -- Extend command_executions with the journaling fields previously on agent_sessions.
      -- A NULL workflow_id is allowed because some commands (e.g. sync-reviewers,
      -- create-reviewer) don't tie to a review workflow. Existing rows get NULL by default.
      ALTER TABLE command_executions ADD COLUMN workflow_id TEXT REFERENCES sessions(id) ON DELETE RESTRICT;
      -- parent_id = the dashboard-spawn that's the "Tech Lead" parent of an AI-spawned
      -- session-instance row. NULL for top-level dashboard spawns.
      ALTER TABLE command_executions ADD COLUMN parent_id INTEGER REFERENCES command_executions(id);
      -- Vendor metadata (claude | opencode | gemini | …). NULL for non-AI commands.
      ALTER TABLE command_executions ADD COLUMN vendor TEXT;
      -- The underlying CLI's own session id, captured from stream events.
      -- Used for resume / handoff. Hidden from users (ocr exposes its own id only).
      ALTER TABLE command_executions ADD COLUMN vendor_session_id TEXT;
      -- Persona/instance metadata for AI sub-agents (set when the AI calls
      -- ocr session start-instance). NULL for the parent dashboard spawn.
      ALTER TABLE command_executions ADD COLUMN persona TEXT;
      ALTER TABLE command_executions ADD COLUMN instance_index INTEGER;
      ALTER TABLE command_executions ADD COLUMN name TEXT;
      -- Resolved model string passed to --model post-alias-expansion.
      ALTER TABLE command_executions ADD COLUMN resolved_model TEXT;
      -- Liveness heartbeat. Bumped on every state event the AI emits.
      -- Stale rows past the threshold are reclassified to orphaned (exit_code=-3).
      ALTER TABLE command_executions ADD COLUMN last_heartbeat_at TEXT;
      -- Free-form annotations (sweep notes, host-CLI capability warnings, etc).
      ALTER TABLE command_executions ADD COLUMN notes TEXT;
      CREATE INDEX idx_command_executions_workflow ON command_executions(workflow_id);
      CREATE INDEX idx_command_executions_parent ON command_executions(parent_id);
      CREATE INDEX idx_command_executions_heartbeat ON command_executions(last_heartbeat_at);

      -- The agent_sessions table is retired. Phase 1 was a parallel journal that
      -- this migration consolidates. We drop the table outright — the only existing
      -- consumers are the cli helpers and tests, which are updated alongside this
      -- migration. No production deployments have agent_sessions data worth migrating.
      DROP INDEX IF EXISTS idx_agent_sessions_workflow;
      DROP INDEX IF EXISTS idx_agent_sessions_status_heartbeat;
      DROP TABLE IF EXISTS agent_sessions;
    `,
  },
  {
    version: 12,
    description:
      "Event-sourced lifecycle hardening: event_type taxonomy guard, sweep indexes, session_completeness view",
    sql: `
      -- ── Indexes for the now-periodic stale-session sweep + round derivation ──
      -- The sweep filters sessions by status and rolls up MAX(created_at) per
      -- session over the event log; deriveNextRound does MAX(round). Index both.
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_events_session_created
        ON orchestration_events(session_id, created_at);

      -- ── Event-type taxonomy guard ──
      -- orchestration_events.event_type is the spine of all lifecycle
      -- derivation. A typo (e.g. 'round_complete' vs 'round_completed') would
      -- silently break deriveNextRound and the completeness view. SQLite cannot
      -- add a CHECK to an existing column without a table rebuild, so enforce
      -- the closed vocabulary with a BEFORE INSERT trigger instead.
      CREATE TRIGGER IF NOT EXISTS trg_events_known_type
      BEFORE INSERT ON orchestration_events
      WHEN NEW.event_type NOT IN (
        'session_created', 'session_resumed', 'round_started', 'phase_transition',
        'round_completed', 'map_completed', 'session_closed', 'session_aborted',
        'session_auto_closed_stale', 'session_synced', 'session_legacy_import'
      )
      BEGIN
        SELECT RAISE(ABORT, 'unknown orchestration_events.event_type');
      END;

      -- ── Close-guard (DB backstop for the completion invariant) ──
      -- A session cannot transition active → closed unless its current
      -- round/run has a terminal artifact event, OR an explicit reason event
      -- (abort / auto-close-stale / sync / legacy-import) is present. Only a
      -- *silent* premature close is banned — every legitimate non-artifact
      -- close carries a reason event and passes. App-level guards in
      -- stateClose/finish are the primary check; this makes the illegal state
      -- unrepresentable even via raw SQL.
      --
      -- DEFENCE-IN-DEPTH NOTE (intentional, documented gap): the reason-event
      -- branch below (event_type IN (...)) is NOT round-scoped — a reason event
      -- recorded for an earlier round would also satisfy a later close. The
      -- app-level guards ARE round-scoped (hasCompletionInvariant checks the
      -- current round/run), so the precise check lives in the application; this
      -- trigger is a coarse backstop against a *silent* premature close via raw
      -- SQL. Tightening it to be round-scoped would require a new migration
      -- (this v12 trigger is append-only and already shipped); the residual
      -- risk is a non-artifact close carrying a stale reason event, which is
      -- still an explicit, audited terminal — not the failure mode this guards.
      CREATE TRIGGER IF NOT EXISTS trg_sessions_close_guard
      BEFORE UPDATE OF status ON sessions
      WHEN NEW.status = 'closed' AND OLD.status <> 'closed'
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_events e
           WHERE e.session_id = NEW.id
             AND (
               (NEW.workflow_type = 'review' AND e.event_type = 'round_completed' AND e.round = NEW.current_round)
               OR (NEW.workflow_type = 'map' AND e.event_type = 'map_completed'   AND e.round = NEW.current_map_run)
               OR e.event_type IN ('session_aborted','session_auto_closed_stale','session_synced','session_legacy_import')
             )
        )
      BEGIN
        SELECT RAISE(ABORT, 'cannot close session without a completed round/run or an explicit reason event');
      END;

      -- ── session_completeness view ──
      -- The published contract for "is this session actually complete, and if
      -- not, what's missing". Completion is DERIVED from the event log, never a
      -- mutable flag: a session is complete iff it is closed AND a terminal
      -- artifact event exists for its current round/run. The dashboard's
      -- outcome derivation and the agent 'status' command read this view, so
      -- they cannot disagree.
      --
      -- completeness_state is an INTENTIONAL HYBRID: it combines the mutable
      -- status column (marked_closed) with append-only event evidence (the
      -- terminal artifact event). This is sound precisely because the
      -- close-guard trigger above makes the status column trustworthy — a row
      -- can only reach status='closed' with a completed round/run or an
      -- explicit reason event — so reading the column is not a regression to
      -- the old "mutable flag that could lie" model.
      --
      --   completeness_state:
      --     'complete'                — closed + terminal artifact for current round/run
      --     'closed_without_artifact' — closed but no terminal artifact (the
      --                                 "completed too soon" condition)
      --     'in_flight'               — open with a dependent process still running
      --     'open_no_artifact'        — open, no in-flight dependents
      CREATE VIEW IF NOT EXISTS session_completeness AS
      SELECT
        s.id              AS session_id,
        s.workflow_type   AS workflow_type,
        s.status          AS status,
        s.current_round   AS current_round,
        s.current_map_run AS current_map_run,
        CASE WHEN EXISTS (
          SELECT 1 FROM orchestration_events e
           WHERE e.session_id = s.id
             AND (
               (s.workflow_type = 'review' AND e.event_type = 'round_completed' AND e.round = s.current_round)
               OR (s.workflow_type = 'map' AND e.event_type = 'map_completed'   AND e.round = s.current_map_run)
             )
        ) THEN 1 ELSE 0 END AS has_terminal_artifact,
        CASE WHEN s.status = 'closed' THEN 1 ELSE 0 END AS marked_closed,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM command_executions ce
           WHERE ce.workflow_id = s.id AND ce.finished_at IS NULL
        ) THEN 1 ELSE 0 END AS dependents_settled,
        CASE
          WHEN s.status = 'closed' AND EXISTS (
            SELECT 1 FROM orchestration_events e
             WHERE e.session_id = s.id
               AND (
                 (s.workflow_type = 'review' AND e.event_type = 'round_completed' AND e.round = s.current_round)
                 OR (s.workflow_type = 'map' AND e.event_type = 'map_completed'   AND e.round = s.current_map_run)
               )
          ) THEN 'complete'
          WHEN s.status = 'closed' THEN 'closed_without_artifact'
          WHEN EXISTS (
            SELECT 1 FROM command_executions ce
             WHERE ce.workflow_id = s.id AND ce.finished_at IS NULL
          ) THEN 'in_flight'
          ELSE 'open_no_artifact'
        END AS completeness_state
      FROM sessions s;
    `,
  },
  {
    version: 13,
    description:
      "Retire dead parent_id column on command_executions (never written; row kind is derived from command)",
    // parent_id was reserved for an AI-instance → dashboard-spawn lineage link
    // that was never wired (no writer, no reader). A process's KIND (supervisor
    // / reviewer-instance / utility) is derived from columns that are always
    // present (command + last_heartbeat_at), so the dead lineage column and its
    // all-NULL index are removed. Re-add a wired parent_id alongside a real
    // consumer (e.g. a parent→child tree view) if lineage is ever needed.
    //
    // Imperative + guarded so the DROP COLUMN (which SQLite can't express as
    // IF EXISTS) is idempotent under re-application.
    run: (db) => {
      if (!columnExists(db, "command_executions", "parent_id")) return;
      db.run("DROP INDEX IF EXISTS idx_command_executions_parent;");
      db.run("ALTER TABLE command_executions DROP COLUMN parent_id;");
    },
  },
  {
    version: 14,
    description:
      "Self-heal markdown_artifacts duplication: collapse NULL-round duplicate rows and add a NULL-safe unique index so the dedup bug cannot recur",
    // The table's `UNIQUE(session_id, artifact_type, round_number, file_path)`
    // never deduped session-level artifacts because SQLite treats NULL ≠ NULL,
    // and the writer used `INSERT OR REPLACE` — so every re-parse of a
    // NULL-round artifact (context.md, map.md, …) appended a duplicate (one
    // context.md reached 775 identical rows, ~177 MB). The writer is now an
    // explicit UPDATE-or-INSERT; this migration heals existing DBs and adds a
    // NULL-collapsing unique index as a DB-level backstop.
    //
    // Orphan-row sweep (FK-dangling children from the pre-FK-enforcement era)
    // is intentionally NOT done here — it needs `PRAGMA foreign_keys = OFF`,
    // which is a no-op inside the migration transaction. `ocr db doctor --fix`
    // performs it outside a transaction.
    run: (db) => {
      // Collapse duplicates, keeping the newest row (max rowid) per logical key.
      db.run(`
        DELETE FROM markdown_artifacts
        WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM markdown_artifacts
          GROUP BY session_id, artifact_type, IFNULL(round_number, -1), file_path
        )
      `);
      // NULL-safe uniqueness: IFNULL(round_number,-1) folds the NULL case so a
      // re-parse can never insert a second row for the same logical artifact.
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_markdown_artifacts_logical
        ON markdown_artifacts(session_id, artifact_type, IFNULL(round_number, -1), file_path)
      `);
    },
  },
];

/** Whether `table` currently has a column named `column` (for idempotent DDL). */
function columnExists(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  const first = result[0];
  if (!first) return false;
  const nameIdx = first.columns.indexOf("name");
  return first.values.some((row) => row[nameIdx] === column);
}

/**
 * Creates the schema_version table if it does not exist.
 */
function ensureSchemaVersionTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT NOT NULL
    );
  `);
}

/**
 * Returns the current schema version (0 if no migrations applied). Exposed
 * so callers (e.g. `ensureDatabase`) can detect a pending major upgrade and
 * snapshot the database before applying it.
 */
export function getSchemaVersion(db: Database): number {
  ensureSchemaVersionTable(db);
  return getCurrentVersion(db);
}

/**
 * Returns the current schema version (0 if no migrations applied).
 */
function getCurrentVersion(db: Database): number {
  const result = db.exec(
    "SELECT MAX(version) as v FROM schema_version",
  );
  if (result.length === 0 || result[0]?.values.length === 0) {
    return 0;
  }
  const val = result[0]?.values[0]?.[0];
  return typeof val === "number" ? val : 0;
}

/**
 * Runs all pending migrations sequentially.
 */
export function runMigrations(db: Database): void {
  ensureSchemaVersionTable(db);
  const currentVersion = getCurrentVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }

    // BEGIN IMMEDIATE acquires the write lock up front, so a concurrent
    // opener queues cleanly behind us under WAL instead of starting a
    // deferred transaction that fails late with SQLITE_BUSY mid-migration.
    db.run("BEGIN IMMEDIATE;");
    try {
      if (migration.sql) db.run(migration.sql);
      migration.run?.(db);
      db.run(
        "INSERT INTO schema_version (version, description) VALUES (?, ?);",
        [migration.version, migration.description],
      );
      db.run("COMMIT;");
    } catch (error) {
      db.run("ROLLBACK;");
      throw error;
    }
  }
}

export { MIGRATIONS };
