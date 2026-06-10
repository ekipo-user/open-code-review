## ADDED Requirements

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

Stale `ocr.db.<pid>.tmp` atomic-write orphans (from the retired sql.js engine, no longer produced) SHALL be reaped on dashboard startup, guarded so that only files whose PID is dead and whose mtime is older than a short window are removed. The live `ocr.db` / `-wal` / `-shm` set SHALL never be touched.

#### Scenario: Startup removes dead temps

- **GIVEN** `.ocr/data` contains `ocr.db.<pid>.tmp` files whose PIDs are not alive
- **WHEN** the dashboard starts
- **THEN** those orphan temp files SHALL be deleted
- **AND** the active database files SHALL be untouched

### Requirement: Operator Database Maintenance Commands

OCR SHALL provide first-class, on-demand database hygiene via `ocr db doctor / vacuum / prune / prune-backups`, productizing the one-time corruption remediation so any operator's database can be inspected and healed without a migration. `doctor` SHALL report size, reclaimable freelist, `integrity_check`, `foreign_key_check` violations, markdown duplicates, and orphan temp/backup files; `doctor --fix` SHALL run the FK-orphan sweep, markdown dedup, orphan-temp reap, and `VACUUM`. The FK-orphan sweep SHALL toggle `PRAGMA foreign_keys` only in autocommit (never inside a transaction) and SHALL NEVER delete from the system-of-record tables (`sessions`, `orchestration_events`, `agent_sessions`, `command_executions`) — a violation there SHALL be reported for manual review, not auto-deleted. Every mutating operation SHALL snapshot the database file first, and the lock-taking operations (`vacuum`, `doctor --fix`) SHALL refuse to run while a live dashboard owns the database unless explicitly forced. `prune-backups` SHALL delete `<db>.bak.*` snapshots while retaining the N most-recent (default 1) as a safety net, supporting `--dry-run`, and SHALL never touch the live database file — the explicit, operator-driven counterpart to `doctor` merely *reporting* backups.

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

`ocr db prune` SHALL remove only the cascade-artifact subtree of OLD CLOSED sessions (bounded by `--older-than` and/or `--keep-sessions`), and SHALL NEVER delete a `sessions` row or any `orchestration_events` — so a pruned session remains fully auditable from its immutable event log. Pruning SHALL require an explicit bound (it does nothing otherwise), SHALL support `--dry-run` to print the exact plan without deleting, and SHALL snapshot before mutating.

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
