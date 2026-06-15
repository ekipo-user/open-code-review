# sqlite-state Specification

## Purpose
The SQLite state layer provides a durable, concurrent-safe single source of truth for all OCR data — workflow state, parsed artifacts, and user interactions — shared by the CLI, AI agents, and dashboard server via `.ocr/data/ocr.db`.
## Requirements
### Requirement: SQLite as Single Source of Truth

The system SHALL use a SQLite database at `.ocr/data/ocr.db` as the single source of truth for all OCR state, replacing `state.json` as the primary state medium.

#### Scenario: Database location

- **GIVEN** OCR is initialized in a project
- **WHEN** any consumer needs to read or write state
- **THEN** it SHALL use `.ocr/data/ocr.db`
- **AND** the database file SHALL be gitignored

#### Scenario: Three-layer schema

- **GIVEN** the database is created
- **WHEN** the schema is inspected
- **THEN** it SHALL contain three distinct layers:
  - Workflow state layer (`sessions`, `orchestration_events`) — written by agents via `ocr state` CLI
  - Artifact layer (`review_rounds`, `reviewer_outputs`, `review_findings`, `markdown_artifacts`, `map_runs`, `map_sections`, `map_files`) — written by FilesystemSync
  - User interaction layer (`user_file_progress`, `user_finding_progress`, `user_notes`, `command_executions`, `schema_version`) — written by dashboard

#### Scenario: Shared consumers

- **GIVEN** the database exists
- **WHEN** the CLI (`ocr state`, `ocr progress`), AI agents (via `ocr state`), and dashboard server all access it
- **THEN** all consumers SHALL read from and write to the same `.ocr/data/ocr.db` file
- **AND** WAL mode SHALL be enabled for concurrent read/write safety

---

### Requirement: Database Auto-Creation

The system SHALL auto-create the SQLite database with full schema when any consumer needs it first.

#### Scenario: First ocr state command

- **GIVEN** `.ocr/` exists but `.ocr/data/ocr.db` does not
- **WHEN** user or agent runs `ocr state init`
- **THEN** `.ocr/data/` directory is created, `ocr.db` is created, all migrations run, and the command completes normally

#### Scenario: First ocr dashboard command

- **GIVEN** `.ocr/` exists but `.ocr/data/ocr.db` does not
- **WHEN** user runs `ocr dashboard`
- **THEN** the database is created with full schema before the server starts

#### Scenario: Database already exists

- **GIVEN** `.ocr/data/ocr.db` exists with current schema
- **WHEN** any consumer opens it
- **THEN** no migration runs and the connection opens normally

---

### Requirement: Schema Migrations

The system SHALL use a versioned, transactional, idempotent migration system that snapshots the database before applying a major schema change and runs reconciliation as part of the upgrade.

#### Scenario: Version tracking

- **WHEN** migrations run
- **THEN** each applied migration is recorded in `schema_version` with version, timestamp, and description

#### Scenario: Sequential, append-only, raw SQL

- **GIVEN** the database is at an earlier schema version
- **WHEN** a newer OCR introduces later versions
- **THEN** only the pending migrations run, in order, each in its own transaction
- **AND** migrations SHALL be raw SQL, sequential, and never modified once shipped

#### Scenario: Pre-migration snapshot for the v12 upgrade

- **GIVEN** an `ocr.db` written by a pre-2.0 version
- **WHEN** the v12 migration is about to apply
- **THEN** the system SHALL copy `ocr.db` to `ocr.db.bak.<fromVersion>` before mutating it

#### Scenario: Reconciliation runs as part of the upgrade

- **WHEN** the v12 migration applies
- **THEN** legacy reconciliation SHALL run as part of the upgrade, after the schema (including the close-guard trigger) is installed — reconciliation needs filesystem access for artifact evidence, so it runs in the application's `ensureDatabase` step, not inside the SQL migration
- **AND** running it after the trigger is safe because (a) the close-guard trigger only fires on an active→closed status change, and (b) reconciliation writes its reason event (`session_legacy_import` / `session_auto_closed_stale`) before any status change, so every reconcile-driven close satisfies the guard
- **AND** the upgrade SHALL complete without any manual user action

#### Scenario: Crash-safe and idempotent

- **GIVEN** a migration is interrupted mid-apply
- **WHEN** the next `ocr` invocation opens the database
- **THEN** the incomplete migration SHALL have rolled back and SHALL re-apply cleanly

### Requirement: Shared DB Access Layer

The system SHALL provide a shared internal module for typed SQLite access used by both the CLI and the dashboard server.

#### Scenario: CLI usage

- **GIVEN** the CLI runs `ocr state init` or `ocr state transition`
- **WHEN** it needs to read or write to SQLite
- **THEN** it SHALL use the shared DB access module for schema, migrations, and typed queries

#### Scenario: Dashboard server usage

- **GIVEN** the dashboard server starts
- **WHEN** it needs to read or write to SQLite
- **THEN** it SHALL use the same shared DB access module as the CLI

#### Scenario: Schema consistency

- **GIVEN** the shared module defines the schema
- **WHEN** both CLI and dashboard use it
- **THEN** schema drift between the two consumers SHALL be impossible

---

### Requirement: Orchestration Event Log

The system SHALL maintain an append-only event log in the `orchestration_events` table for every state change made via `ocr state` commands.

#### Scenario: Session creation event

- **WHEN** `ocr state init` runs
- **THEN** a row is inserted into `orchestration_events` with `event_type = 'session_created'`

#### Scenario: Phase transition event

- **WHEN** `ocr state transition` runs
- **THEN** a row is inserted with `event_type = 'phase_transition'`, the phase name, and phase number

#### Scenario: Session close event

- **WHEN** `ocr state close` runs
- **THEN** a row is inserted with `event_type = 'session_closed'`

#### Scenario: Round completed event

- **WHEN** `ocr state round-complete` runs
- **THEN** a row is inserted with `event_type = 'round_completed'`, the round number in the `round` column, and metadata JSON containing the per-round counts in the canonical **category** vocabulary (`blocker_count`, `should_fix_count`, `suggestion_count`, `reviewer_count`, `total_finding_count`) and `source: "orchestrator"`
- **AND** those per-category counts SHALL be the values returned by the shared `Canonical Round Count Derivation` helper — this scenario records them, it does NOT define a second derivation (the retired `critical_count`/`major_count`/`nitpick_count` fields mixed the severity vocabulary and are not written)

#### Scenario: Map completed event

- **WHEN** `ocr state map-complete` runs
- **THEN** a row is inserted with `event_type = 'map_completed'`, the map run number in the `round` column, and metadata JSON containing derived counts (`section_count`, `file_count`) and `source: "orchestrator"`

#### Scenario: Immutable log

- **GIVEN** events exist in `orchestration_events`
- **WHEN** any consumer accesses the table
- **THEN** rows SHALL NOT be updated or deleted
- **AND** new events are always appended

#### Scenario: Timeline reconstruction

- **GIVEN** a session has multiple orchestration events
- **WHEN** the dashboard queries events for a session
- **THEN** a complete timeline of phase transitions, round starts, round completions, map completions, and status changes can be reconstructed from the event log

---

### Requirement: OCR State Init Command (SQLite)

The `ocr state init` CLI command SHALL write session state to SQLite instead of (or in addition to) `state.json`.

#### Scenario: Create session in SQLite

- **WHEN** agent runs `ocr state init`
- **THEN** a row is inserted into the `sessions` table with initial state (phase=context, status=active)
- **AND** a `session_created` event is inserted into `orchestration_events`
- **AND** the session ID is returned to stdout

#### Scenario: Backward-compatible state.json write

- **WHEN** `ocr state init` completes the SQLite write
- **THEN** it SHALL also write `state.json` as a backward-compatible side-effect

---

### Requirement: OCR State Transition Command (SQLite)

The `ocr state transition` CLI command SHALL update session state in SQLite and log the transition event.

#### Scenario: Phase transition

- **WHEN** agent runs `ocr state transition --phase reviews --phase-number 4`
- **THEN** the `sessions` row is updated with the new phase and phase number
- **AND** a `phase_transition` event is inserted into `orchestration_events`

#### Scenario: Round change

- **WHEN** agent runs a transition that changes the round number
- **THEN** a `round_started` event is also inserted into `orchestration_events`

#### Scenario: Backward-compatible state.json write

- **WHEN** `ocr state transition` completes the SQLite write
- **THEN** it SHALL also write `state.json` as a backward-compatible side-effect

---

### Requirement: OCR State Close Command (SQLite)

The `ocr state close` CLI command SHALL mark a session as closed in SQLite.

#### Scenario: Close session

- **WHEN** agent runs `ocr state close`
- **THEN** the `sessions` row is updated with `status = 'closed'` and `current_phase = 'complete'`
- **AND** a `session_closed` event is inserted into `orchestration_events`

#### Scenario: Backward-compatible state.json write

- **WHEN** `ocr state close` completes the SQLite write
- **THEN** it SHALL also write `state.json` as a backward-compatible side-effect

---

### Requirement: OCR State Show Command (SQLite)

The `ocr state show` CLI command SHALL read session state from SQLite.

#### Scenario: Show session state

- **WHEN** user or agent runs `ocr state show`
- **THEN** the command reads from the `sessions` table and recent `orchestration_events`
- **AND** displays current phase, round, status, and recent events

---

### Requirement: OCR State Sync Command (SQLite)

The `ocr state sync` CLI command SHALL trigger FilesystemSync logic to parse filesystem artifacts into SQLite.

#### Scenario: Manual sync

- **WHEN** user runs `ocr state sync`
- **THEN** the command scans `.ocr/sessions/` and upserts artifact data into SQLite
- **AND** backfills any `sessions` rows that exist on filesystem but not in the DB (legacy migration)

---

### Requirement: Data Durability

All data SHALL survive dashboard restarts, full filesystem re-syncs, CLI upgrades, and concurrent writes.

#### Scenario: Dashboard restart preserves user data

- **GIVEN** user has marked files as reviewed and triaged findings
- **WHEN** the dashboard restarts
- **THEN** all user progress (`user_file_progress`, `user_finding_progress`, `user_notes`) is preserved

#### Scenario: Filesystem re-sync preserves user data

- **WHEN** FilesystemSync runs a full re-import from `.ocr/sessions/`
- **THEN** user interaction tables are never touched
- **AND** artifact tables are upserted without data loss

#### Scenario: Concurrent writes from agents and dashboard

- **GIVEN** an AI agent writes via `ocr state` while the dashboard writes user progress
- **WHEN** both writes occur simultaneously
- **THEN** WAL mode and busy timeout (5s) ensure both writes succeed without corruption

#### Scenario: Foreign key cascade

- **GIVEN** user data references workflow data via foreign keys
- **WHEN** a session is deleted (e.g., manual cleanup)
- **THEN** related user data is cascade-deleted via `ON DELETE CASCADE`

---

### Requirement: SQLite Connection Pragmas

The system SHALL apply concurrency and integrity pragmas on every `node:sqlite` connection open, and write transactions SHALL use immediate locking with bounded retry.

#### Scenario: WAL mode

- **WHEN** a connection to `ocr.db` is opened
- **THEN** `PRAGMA journal_mode = WAL` SHALL be set and SHALL take effect on the on-disk file

#### Scenario: Foreign keys

- **WHEN** a connection to `ocr.db` is opened
- **THEN** `PRAGMA foreign_keys = ON` SHALL be set

#### Scenario: Busy timeout and synchronous

- **WHEN** a connection to `ocr.db` is opened
- **THEN** `PRAGMA busy_timeout = 5000` and `PRAGMA synchronous = NORMAL` SHALL be set

#### Scenario: Immediate write transactions with retry

- **WHEN** a writer opens a transaction
- **THEN** it SHALL use `BEGIN IMMEDIATE`
- **AND** on `SQLITE_BUSY` it SHALL retry with bounded backoff (recommended: 5 retries, 50ms backoff)

---

### Requirement: Source Tracking on Artifact Tables

The `review_rounds` and `map_runs` artifact tables SHALL include a `source` column that tracks how the data was populated, enabling an orchestrator-first data flow.

#### Scenario: Orchestrator source

- **GIVEN** a completion command (`round-complete` or `map-complete`) has been run
- **WHEN** the dashboard processes the corresponding orchestration event
- **THEN** the artifact row's `source` column SHALL be set to `'orchestrator'`
- **AND** subsequent filesystem parser runs SHALL NOT overwrite orchestrator-provided data

#### Scenario: Parser source

- **GIVEN** no completion command has been run for a round or map run
- **WHEN** FilesystemSync parses a markdown artifact
- **THEN** the artifact row's `source` column SHALL be set to `'parser'`

#### Scenario: Source latch

- **GIVEN** a row has `source = 'orchestrator'`
- **WHEN** FilesystemSync encounters the same artifact
- **THEN** it SHALL skip re-parsing structured data (sections, files, findings)
- **AND** it SHALL still store raw markdown content for display purposes

#### Scenario: Map runs section count

- **GIVEN** migration v7 has been applied
- **WHEN** the `map_runs` table is inspected
- **THEN** it SHALL include a `section_count` column (INTEGER, default 0)
- **AND** it SHALL include a `source` column (TEXT, default NULL)

### Requirement: WAL Hygiene on Dashboard Startup

The system SHALL checkpoint the on-disk SQLite write-ahead log before the
dashboard process accepts client connections, so that a stale or unbounded
`.db-wal` does not persist across sessions.

The engine is Node's built-in `node:sqlite` (WAL mode), so the dashboard issues
the checkpoint **directly against its own connection** (`walCheckpointTruncate`
in `packages/shared/persistence/src/db/index.ts`) — no external `sqlite3` shellout is
required.

#### Scenario: Dashboard checkpoints the WAL at startup

- **GIVEN** the dashboard process is starting
- **WHEN** initialization reaches the database-readiness step
- **THEN** the system SHALL issue `PRAGMA wal_checkpoint(TRUNCATE)` against `.ocr/data/ocr.db` via its own node:sqlite connection

#### Scenario: WAL checkpoint failure does not block startup

- **GIVEN** the dashboard process is starting
- **AND** the checkpoint raises (e.g. permissions, a locked file)
- **WHEN** the checkpoint step completes
- **THEN** the system SHALL continue startup normally
- **AND** the failure SHALL NOT raise an exception or terminate the process

### Requirement: Liveness Sweep on Startup

The system SHALL run an `agent_sessions` liveness sweep before the dashboard process accepts client connections, so that ghost `running` rows from a prior session that crashed before completion are reconciled at the earliest possible moment.

#### Scenario: Stale running sessions are reclassified

- **GIVEN** a previous `agent_sessions` row exists with `status = 'running'` and `last_heartbeat_at` older than the configured threshold
- **WHEN** dashboard startup runs the liveness sweep
- **THEN** the row SHALL transition to `status = 'orphaned'` with `ended_at` set to the sweep timestamp
- **AND** a `notes` entry SHALL be appended explaining auto-reclassification

#### Scenario: Active sessions are untouched

- **GIVEN** an `agent_sessions` row exists with `last_heartbeat_at` within the threshold
- **WHEN** the liveness sweep runs
- **THEN** the row's `status` SHALL remain `running`
- **AND** no other fields SHALL be modified

---

### Requirement: Concurrent Writer Serialization

The system SHALL serialize concurrent writes to `.ocr/data/ocr.db` from the CLI
process and the dashboard process via the engine's WAL locking, so that neither
writer's changes are silently overwritten by the other.

The engine is Node's built-in `node:sqlite` in WAL mode. Cross-process atomicity
is provided by SQLite's own single-writer/multi-reader WAL locking and SQL
transactions — **not** by any file-level merge layer. The former `sql.js`
merge-before-write path (`DbSyncWatcher`, `registerSaveHooks`, the save hooks) is
retired.

#### Scenario: Writers acquire the write lock up front

- **GIVEN** a process opens a write transaction
- **WHEN** the transaction begins
- **THEN** it SHALL use `BEGIN IMMEDIATE` (acquire the write lock up front) rather than deferred mode
- **AND** it SHALL retry on `SQLITE_BUSY` (errcode 5 / 261) with bounded backoff (5 retries × 50ms)

#### Scenario: A contended write waits out a held lock rather than failing

- **GIVEN** one process holds the WAL write lock
- **WHEN** a second process opens its own write transaction against the same DB
- **THEN** the second writer SHALL block (via `busy_timeout` + the bounded retry) until the lock is released, then commit
- **AND** both writers' changes SHALL be durably present — neither is lost to contention

### Requirement: Event Log as Lifecycle Source of Truth

The `orchestration_events` log SHALL be the single source of truth for session lifecycle (status, current phase, current round, current map run, completion). The `sessions` table SHALL be a projection derived from the event log, never written independently of the event that justifies it.

#### Scenario: Lifecycle mutation is atomic with its event

- **WHEN** a lifecycle mutation occurs (e.g. phase advance, round completion, finish)
- **THEN** the corresponding `orchestration_events` row and the `sessions` projection update SHALL be committed in a single `node:sqlite` transaction
- **AND** the projection SHALL NOT reflect a lifecycle fact absent from the event log

#### Scenario: Completion is derived, not asserted

- **WHEN** a consumer needs to know whether a review round is complete
- **THEN** completeness SHALL be derived from the existence of a `round_completed` event for the current round
- **AND** there SHALL be no independently-writable boolean "complete" flag that can disagree with the log

#### Scenario: Projection is rebuildable from the log

- **GIVEN** the `sessions` projection for a session
- **WHEN** it is recomputed from that session's `orchestration_events`
- **THEN** the recomputed status, phase, round, and map run SHALL equal the stored projection

---

### Requirement: Event Type Taxonomy Constraint

The system SHALL constrain `orchestration_events.event_type` to a closed, canonical vocabulary at the database layer so that a typo cannot silently corrupt lifecycle derivation.

#### Scenario: Known event types are accepted

- **WHEN** an event with `event_type` in {`session_created`, `session_resumed`, `round_started`, `phase_transition`, `round_completed`, `map_completed`, `session_closed`, `session_aborted`, `session_auto_closed_stale`, `session_synced`, `session_legacy_import`} is inserted
- **THEN** the insert SHALL succeed

#### Scenario: Unknown event type is rejected

- **WHEN** an event with an `event_type` outside the canonical vocabulary (e.g. `round_complete`) is inserted
- **THEN** the database SHALL reject the insert
- **AND** lifecycle derivation SHALL be protected from the typo

---

### Requirement: Session Completion Invariant Enforcement

The system SHALL enforce, at the database layer, that a session cannot be marked `closed` without either a terminal artifact event for its current round/run or an explicit reason event, so that "completed too soon" is unrepresentable even via direct SQL.

#### Scenario: Close with a completed round is allowed

- **GIVEN** a review session whose current round has a `round_completed` event
- **WHEN** its `status` is set to `closed`
- **THEN** the update SHALL succeed

#### Scenario: Silent premature close is rejected

- **GIVEN** a review session whose current round has no `round_completed` event
- **WHEN** an attempt is made to set `status = 'closed'` with no reason event present
- **THEN** the database SHALL abort the update

#### Scenario: Explicit non-artifact close is allowed via reason event

- **GIVEN** a session being aborted, auto-closed for staleness, synced, or legacy-imported
- **WHEN** `status` is set to `closed` together with the corresponding reason event (`session_aborted`, `session_auto_closed_stale`, `session_synced`, or `session_legacy_import`)
- **THEN** the update SHALL succeed
- **AND** the session SHALL carry a queryable record of why it closed without an artifact

---

### Requirement: Session Completeness View

The system SHALL expose a `session_completeness` view that derives, per session, whether it is genuinely complete and — when not — which obligations are unmet, as the published contract consumed by the dashboard and the agent `status` command.

`completeness_state` is an intentional hybrid of the mutable `status` column (marked closed) and append-only event evidence (the terminal artifact event). This is sound because the close-guard trigger makes the `status` column trustworthy — a row can only reach `status = 'closed'` with a completed round/run or an explicit reason event — so reading the column is not a regression to a mutable flag that could lie.

#### Scenario: View reports completeness state

- **WHEN** the `session_completeness` view is queried for a session
- **THEN** it SHALL return a `completeness_state` of one of `complete`, `closed_without_artifact`, `in_flight`, or `open_no_artifact`
- **AND** it SHALL return per-obligation booleans (terminal artifact present, marked closed, dependents settled)

#### Scenario: Premature completion is a single-query detection

- **WHEN** the view is queried with `completeness_state = 'closed_without_artifact'`
- **THEN** it SHALL return exactly the sessions that were closed without a completed round/run
- **AND** this query SHALL be the canonical detection for the "completed too soon" condition

---

### Requirement: Automatic Legacy State Reconciliation

The system SHALL provide an idempotent reconciliation that derives true lifecycle state from the event log and filesystem artifacts and repairs the projection, run automatically during migration and on demand via `ocr state reconcile`.

#### Scenario: Synthesize completion from a provable artifact

- **GIVEN** a legacy session closed without a `round_completed` event
- **AND** the latest round directory contains a `final.md`
- **WHEN** reconciliation runs
- **THEN** it SHALL synthesize a `round_completed` event for that round from the artifact
- **AND** it SHALL record a reconciliation event documenting the synthesis

#### Scenario: Grandfather when completion cannot be proven

- **GIVEN** a legacy closed session with no `round_completed` event and no `final.md`
- **WHEN** reconciliation runs
- **THEN** it SHALL emit a `session_legacy_import` reason event rather than fabricate completion
- **AND** the close SHALL satisfy the completion-invariant via that reason event

#### Scenario: Dry run reports the plan without writing

- **WHEN** `ocr state reconcile --dry-run` runs
- **THEN** it SHALL print every repair it would perform
- **AND** it SHALL make no changes to the database

#### Scenario: Reconciliation is idempotent

- **WHEN** reconciliation runs twice in succession
- **THEN** the second run SHALL make no further changes

### Requirement: Built-in SQLite Engine

OCR's SQLite engine SHALL be Node's built-in `node:sqlite` (`DatabaseSync`,
on-disk, WAL) — **not** a native dependency. There SHALL be no native module, no
prebuilt binary, and no dependency install script, so the engine is present on
any supported runtime without a build step. This requires **Node >= 22.5** (when
`node:sqlite` landed). The engine is accessed only through the `Database` adapter
seam (`db/engine.ts`); no consumer reaches the underlying handle.

#### Scenario: The engine is the built-in, with no native dependency

- **WHEN** the CLI or dashboard opens the database
- **THEN** it SHALL load `node:sqlite` (not `better-sqlite3` or any native addon)
- **AND** there SHALL be no prebuilt binary or install script involved

#### Scenario: WAL pragmas are applied on open

- **WHEN** a connection is opened via the engine
- **THEN** it SHALL apply `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`

#### Scenario: A too-old runtime fails with a clear message

- **GIVEN** a runtime older than Node 22.5
- **WHEN** the engine is loaded (from any entry point — the bin, the `./db` subpath, or the dashboard server)
- **THEN** it SHALL raise an actionable "requires Node >= 22.5" error, not an opaque module-load failure

### Requirement: Canonical Round Count Derivation

Per-round finding counts SHALL be derived by a single shared rule, defined once
and consumed by every producer and consumer of those counts, so the count
representation cannot drift between the CLI writer and the dashboard reader. The
rule SHALL be a pure function in `@open-code-review/platform`, exported on a
Node-free subpath per `package-architecture`'s `Browser-consumed shared code is
exported on Node-free subpaths` requirement, so the dashboard browser bundle can
import it without dragging in Node built-ins.

The value the rule returns for the `blocker` category is the **canonical round
blocker count** — the domain term used by every consumer (the CLI's directional
verdict check, the synthesizer guidance, the dashboard's mismatch hint) so no
consumer re-derives it or names a TypeScript symbol in its contract.

The rule SHALL key off the canonical finding-category vocabulary
(`blocker / should_fix / suggestion / style`) — not ad-hoc count-field names or
event-metadata keys — and SHALL be: **prefer the deduplicated `synthesis_counts`
when present; otherwise derive the per-category tally from `findings[].category`.**
The `style` category has no named synthesis counter and SHALL be derived from
findings only; this omission SHALL be documented at the shared helper so it is not
"corrected" at a call site.

The directional `synthesis_counts` cross-check SHALL be expressed as
*derive-then-compare* against this same helper: compute the derived per-category
tally once, then assert each present `synthesis_counts.X` is `≥ 0` and does not
exceed the derived tally. It SHALL NOT be a second, independent transcription of
the derivation rule.

#### Scenario: Single source of truth for the derivation rule

- **WHEN** the CLI writer computes round counts and the dashboard reader computes round counts for the same round metadata
- **THEN** both SHALL call the same shared `@open-code-review/platform` derivation function
- **AND** they SHALL produce identical per-category counts for identical input
- **AND** there SHALL be no second or third in-line copy of the "prefer `synthesis_counts` else derive by category" rule

#### Scenario: synthesis_counts is preferred when present

- **GIVEN** round metadata whose `synthesis_counts` is present
- **WHEN** the shared helper resolves the round counts
- **THEN** it SHALL return the `synthesis_counts` values (the deduplicated totals)

#### Scenario: Counts are derived from categories when synthesis_counts is absent

- **GIVEN** round metadata with no `synthesis_counts`
- **WHEN** the shared helper resolves the round counts
- **THEN** it SHALL derive each count as the tally of findings carrying the corresponding `category`

#### Scenario: Directional cross-check is derive-then-compare

- **WHEN** round metadata with a present `synthesis_counts` is validated
- **THEN** the validator SHALL derive the per-category tally via the shared helper and assert each `synthesis_counts.X` is `≥ 0` and `≤` the derived tally
- **AND** the cross-check SHALL reuse the shared derivation rather than re-implement it

### Requirement: Artifact Rows Do Not Duplicate

Re-parsing an unchanged or changed markdown artifact SHALL NOT increase the row count in `markdown_artifacts` for the same logical key (`session_id`, `artifact_type`, round, `file_path`). The writer SHALL update the existing row in place, and a NULL-safe unique index (folding `round_number` via `IFNULL(round_number, -1)`) SHALL enforce this at the database layer so a NULL-round (session-level) artifact cannot accumulate duplicate rows.

#### Scenario: Re-parsing a session-level artifact does not append

- **GIVEN** a `context.md` (round_number NULL) already recorded
- **WHEN** it is re-parsed
- **THEN** the existing row SHALL be updated in place
- **AND** `markdown_artifacts` SHALL contain exactly one row for that logical key

#### Scenario: Migration heals existing duplication

- **GIVEN** a database with duplicate NULL-round markdown rows from the prior `INSERT OR REPLACE` bug
- **WHEN** migrations are applied
- **THEN** duplicates SHALL be collapsed to the newest row per logical key
- **AND** the NULL-safe unique index SHALL be present

### Requirement: Orphan Temp File Hygiene

Stale `ocr.db.<pid>.tmp` atomic-write orphans (from the retired sql.js engine, no longer produced) SHALL be reaped on dashboard startup, guarded so that only files whose PID is dead and whose mtime is older than a short window are removed. The live `ocr.db` / `-wal` / `-shm` set SHALL NOT be touched.

#### Scenario: Startup removes dead temps

- **GIVEN** `.ocr/data` contains `ocr.db.<pid>.tmp` files whose PIDs are not alive
- **WHEN** the dashboard starts
- **THEN** those orphan temp files SHALL be deleted
- **AND** the active database files SHALL be untouched

### Requirement: Operator Database Maintenance Commands

OCR SHALL provide first-class, on-demand database hygiene via `ocr db doctor / vacuum / prune / prune-backups`, productizing the one-time corruption remediation so any operator's database can be inspected and healed without a migration. `doctor` SHALL report size, reclaimable freelist, `integrity_check`, `foreign_key_check` violations, markdown duplicates, and orphan temp/backup files; `doctor --fix` SHALL run the FK-orphan sweep, markdown dedup, orphan-temp reap, and `VACUUM`. The FK-orphan sweep SHALL toggle `PRAGMA foreign_keys` only in autocommit (never inside a transaction) and SHALL NOT delete from the system-of-record tables (`sessions`, `orchestration_events`, `agent_sessions`, `command_executions`) — a violation there SHALL be reported for manual review, not auto-deleted. Every mutating operation SHALL snapshot the database file first, and the lock-taking operations (`vacuum`, `doctor --fix`) SHALL refuse to run while a live dashboard owns the database unless explicitly forced. `prune-backups` SHALL delete `<db>.bak.*` snapshots while retaining the N most-recent (default 1) as a safety net, supporting `--dry-run`, and SHALL NOT touch the live database file — the explicit, operator-driven counterpart to `doctor` merely *reporting* backups.

#### Scenario: prune-backups reclaims old snapshots but keeps the newest

- **GIVEN** several `ocr.db.bak.*` snapshots and `ocr db prune-backups --keep 1`
- **THEN** all but the most-recent snapshot SHALL be deleted
- **AND** the live `ocr.db` SHALL be untouched

#### Scenario: doctor --fix heals orphans and reclaims space

- **GIVEN** a database with FK-orphan rows in cascade-artifact tables and a non-empty freelist
- **WHEN** `ocr db doctor --fix` runs
- **THEN** it SHALL snapshot the file, sweep the orphans, `VACUUM`, and report `foreign_key_check` = 0 with `integrity_check` ok afterward
- **AND** `orchestration_events` and `sessions` row counts SHALL be unchanged

#### Scenario: A protected-table violation is reported, not deleted

- **GIVEN** an orphan row exists in a system-of-record table
- **WHEN** `ocr db doctor --fix` runs
- **THEN** that row SHALL be preserved and surfaced as needing manual review

### Requirement: Artifact Retention Prunes Only Derived Data

`ocr db prune` SHALL remove only the cascade-artifact subtree of OLD CLOSED sessions (bounded by `--older-than` and/or `--keep-sessions`), and SHALL NOT delete a `sessions` row or any `orchestration_events` — so a pruned session remains fully auditable from its immutable event log. Pruning SHALL require an explicit bound (it does nothing otherwise), SHALL support `--dry-run` to print the exact plan without deleting, and SHALL snapshot before mutating.

#### Scenario: Prune drops artifacts but keeps the audit trail

- **GIVEN** a closed session older than the retention bound with derived artifacts
- **WHEN** `ocr db prune --older-than <days>` runs
- **THEN** that session's artifact rows SHALL be deleted
- **AND** its `sessions` row and all its `orchestration_events` SHALL remain

#### Scenario: No bound prunes nothing

- **GIVEN** `ocr db prune` is invoked with neither `--older-than` nor `--keep-sessions`
- **THEN** nothing SHALL be deleted

### Requirement: Per-Execution Agent Log Hygiene

Detached workflow agents write their stdout/stderr to a per-execution log file under `data/exec-logs/<uid>.log` (see the dashboard's File-Stdio Process Isolation requirement). These logs SHALL be retained for post-mortem debugging but reaped past a bounded age (default 7 days) on dashboard startup so they cannot grow without bound.

#### Scenario: Stale agent logs are reaped on startup

- **GIVEN** `data/exec-logs` contains `<uid>.log` files older than the retention window
- **WHEN** the dashboard starts
- **THEN** those stale logs SHALL be deleted and recent logs SHALL be kept

### Requirement: Stranded-Run Next-Action Derivation

The system SHALL derive, for any session, the **current phase**, the ordered **remaining phases**, and a typed **next-action**, computed from the `orchestration_events` log and the liveness tables (`agent_sessions`, `command_executions`) — never from filesystem inspection. This derivation SHALL be a single shared pure function (the same single-source-of-truth discipline as the canonical round-count and verdict helpers) so that the CLI `status` command, the dashboard watchdog, and the orchestrator's resume loop all compute the same target and cannot drift.

The **current phase** SHALL be the phase projected from the latest `phase_transition` event for the current round (phase transitions are emitted at phase entry). The **remaining phases** SHALL be the ordered legal-graph phases from `current_phase` through `complete`. The derivation SHALL NOT attempt to assert that any phase's artifact is "validated" — the event log carries no per-phase artifact-evidence event; the only terminal artifact evidence is the `round_completed` (or `map_completed`) event, consistent with `Session Completeness View`.

The **next_action** SHALL be a closed enum, one of:

- `none` — the session is complete (`round_completed` present) or genuinely closed;
- `finish` — the current round/run is complete but the session is still `active` (the `Auto-Finalize` case);
- `forward_resume` — the run is stranded mid-pipeline (`active`, no `round_completed`, owning turn ended, attempts below cap) and forward-resumable from `current_phase`;
- `abort_or_fresh` — the run cannot be advanced forward (the cap is exhausted, or there is no legal forward edge), so the operator must abort or start a fresh review.

**"Owning turn ended" is evaluated from the caller's perspective**: it means no
agent-session instance *other than the caller* is currently advancing the run
(none unended with a fresh heartbeat). A human re-invoking the review skill is
itself the takeover signal — Phase 0 reads `status --json` before journaling its
own new instance, so the prior turn registers as ended and the caller reads
`next_action = forward_resume` for an incomplete round. The derivation therefore
does NOT require a *globally* dead workflow (which would wrongly read `none`
while the caller is alive); it requires only that no OTHER live turn owns the
round. (The dashboard tier additionally gates auto-spawn on positive death
evidence — see `Forward-Resume of a Stranded Mid-Pipeline Run`.)

#### Scenario: Derivation reports the current phase and remaining phases

- **WHEN** the derivation runs for a session whose current round has `current_phase = reviews` and no `round_completed` event
- **THEN** it SHALL report `current_phase = reviews`
- **AND** it SHALL report the ordered remaining phases through `complete`
- **AND** it SHALL report `next_action = forward_resume`

#### Scenario: Derivation distinguishes forward-resumable from cap-exhausted

- **GIVEN** a stranded run whose current round already has `forward_resume_max_attempts` `forward_resume` lease events (`session_resumed` with `kind = forward_resume`)
- **WHEN** the derivation runs
- **THEN** it SHALL report `next_action = abort_or_fresh` rather than `forward_resume`

#### Scenario: Derivation is sourced from the event log, never the filesystem

- **GIVEN** a stranded run whose `final.md` happens to be present on disk but for which no `round_completed` event exists
- **WHEN** the derivation runs
- **THEN** it SHALL NOT treat the on-disk `final.md` as completion evidence
- **AND** `current_phase` SHALL reflect only the recorded `phase_transition` events

#### Scenario: next_action is a closed enum

- **WHEN** any consumer reads the derivation's `next_action`
- **THEN** the value SHALL be exactly one of `none`, `finish`, `forward_resume`, or `abort_or_fresh`

