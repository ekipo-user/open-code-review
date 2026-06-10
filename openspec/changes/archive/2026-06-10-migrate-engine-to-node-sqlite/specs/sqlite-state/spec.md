## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: WAL Hygiene on Dashboard Startup

The system SHALL checkpoint the on-disk SQLite write-ahead log before the
dashboard process accepts client connections, so that a stale or unbounded
`.db-wal` does not persist across sessions.

The engine is Node's built-in `node:sqlite` (WAL mode), so the dashboard issues
the checkpoint **directly against its own connection** (`walCheckpointTruncate`
in `packages/cli/src/lib/db/index.ts`) — no external `sqlite3` shellout is
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

## REMOVED Requirements

### Requirement: Native SQLite Engine

**Reason**: Superseded by "Built-in SQLite Engine". v2.1.0 migrated the engine from the `better-sqlite3` native dependency to Node's built-in `node:sqlite`, so the better-sqlite3 requirement no longer reflects the implementation. The specs must describe the current built-in engine, not the retired native one.

**Migration**: Engine access is unchanged behind the `Database` adapter seam (`db/engine.ts`); the on-disk SQLite file format is identical, so an existing `.ocr/data/ocr.db` opens in place with no export/import. The only operational change is the Node >= 22.5 floor required by `node:sqlite`.
