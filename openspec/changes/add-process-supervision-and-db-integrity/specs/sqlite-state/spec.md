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
