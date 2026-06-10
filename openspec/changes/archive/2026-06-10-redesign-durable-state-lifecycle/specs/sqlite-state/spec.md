## ADDED Requirements

### Requirement: Native SQLite Engine

The system SHALL use `better-sqlite3` as its SQLite engine, opening `.ocr/data/ocr.db` as an on-disk database with write-ahead logging, replacing the prior in-memory `sql.js` engine and its file-level merge layer.

#### Scenario: On-disk engine with WAL

- **WHEN** any consumer (CLI or dashboard) opens `.ocr/data/ocr.db`
- **THEN** it SHALL open the file with `better-sqlite3` and `PRAGMA journal_mode = WAL`
- **AND** reads SHALL observe writes committed by other processes without a manual merge step

#### Scenario: Existing database opens in place

- **GIVEN** an `.ocr/data/ocr.db` previously written by the `sql.js` engine
- **WHEN** the native engine opens it for the first time after upgrade
- **THEN** it SHALL open the existing file in place without export/import
- **AND** the on-disk SQLite format SHALL be unchanged

#### Scenario: Merge layer is retired

- **GIVEN** the native engine with WAL is in use
- **WHEN** the CLI and dashboard write concurrently
- **THEN** cross-process consistency SHALL be provided by SQLite WAL locking
- **AND** the in-memory `DbSyncWatcher` merge logic, mtime watermark, save hooks, and full-image `db.export()` writes SHALL NOT be used

#### Scenario: Native module unavailable

- **GIVEN** the `better-sqlite3` native binding fails to load on the host platform
- **WHEN** `ocr doctor` runs
- **THEN** it SHALL report the native-module load failure with remediation guidance
- **AND** the failure message SHALL distinguish "unsupported platform" from "missing build tools"

---

### Requirement: Event Log as Lifecycle Source of Truth

The `orchestration_events` log SHALL be the single source of truth for session lifecycle (status, current phase, current round, current map run, completion). The `sessions` table SHALL be a projection derived from the event log, never written independently of the event that justifies it.

#### Scenario: Lifecycle mutation is atomic with its event

- **WHEN** a lifecycle mutation occurs (e.g. phase advance, round completion, finish)
- **THEN** the corresponding `orchestration_events` row and the `sessions` projection update SHALL be committed in a single `better-sqlite3` transaction
- **AND** the projection SHALL never reflect a lifecycle fact absent from the event log

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

## MODIFIED Requirements

### Requirement: SQLite Connection Pragmas

The system SHALL apply concurrency and integrity pragmas on every `better-sqlite3` connection open, and write transactions SHALL use immediate locking with bounded retry.

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

### Requirement: Concurrent Writer Serialization

The system SHALL serialize concurrent writes to `.ocr/data/ocr.db` from the CLI and dashboard processes via native SQLite WAL locking, replacing the prior merge-before-write file-level pattern.

#### Scenario: Native serialization of concurrent writes

- **GIVEN** the CLI writes lifecycle state while the dashboard writes its own tables
- **WHEN** both writes occur concurrently
- **THEN** SQLite WAL locking SHALL serialize them so neither is lost
- **AND** no in-memory merge step SHALL be required

#### Scenario: Reader sees committed writes

- **GIVEN** the dashboard holds an open read connection
- **WHEN** a separate CLI process commits a lifecycle change
- **THEN** the dashboard's next query SHALL observe the committed change

#### Scenario: Lifecycle write ownership

- **WHEN** the dashboard needs to mutate session lifecycle
- **THEN** it SHALL do so by invoking the `ocr state` CLI, not by writing `sessions`/`orchestration_events` directly
- **AND** the dashboard SHALL write directly only to its owned tables (process-supervision journal and UX state)

---

### Requirement: WAL Hygiene on Dashboard Startup

The system SHALL checkpoint the on-disk write-ahead log directly through its native connection on dashboard startup and on clean shutdown, so the main database file remains current.

#### Scenario: Native checkpoint on startup

- **WHEN** the dashboard starts
- **THEN** it SHALL issue `PRAGMA wal_checkpoint(TRUNCATE)` through its `better-sqlite3` connection
- **AND** the external `sqlite3` shellout SHALL no longer be used

#### Scenario: Checkpoint on clean shutdown for downgrade safety

- **WHEN** a process closes its database connection cleanly
- **THEN** it SHALL checkpoint-truncate the WAL so the main file is current
- **AND** an older `sql.js` build SHALL be able to read the main file after a downgrade

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

## REMOVED Requirements

### Requirement: Agent Sessions Table

**Reason**: Superseded by migration v11 (already shipped), which consolidated `agent_sessions` into `command_executions`. The standalone table no longer exists; this specification text is stale and is removed to avoid implying a table that has been dropped. Process-supervision journaling is covered by the `command_executions` schema owned by the dashboard.

**Migration**: No data migration required — v11 dropped the table after consolidating its consumers. Liveness, resume, and per-instance model attribution are served by `command_executions` columns.
