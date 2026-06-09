## ADDED Requirements

### Requirement: Atomic State Lifecycle Commands

The CLI SHALL provide a semantic, atomic porcelain for workflow lifecycle so that orchestrating agents make correct state updates by default and cannot leave a round partially completed. Each command SHALL perform all of its mutations within a single database transaction.

#### Scenario: Begin starts or resumes a workflow

- **WHEN** an agent runs `ocr state begin --workflow-type review`
- **THEN** the command SHALL create or resume the session and emit JSON `{session_id, round, phase, completeness}`
- **AND** session resolution SHALL follow `--session-id` → `OCR_DASHBOARD_EXECUTION_UID` → single active session, refusing when more than one active session exists and none is specified

#### Scenario: Advance validates the phase graph and derives the phase number

- **WHEN** an agent runs `ocr state advance --phase reviews`
- **THEN** the command SHALL reject the transition if it is not a legal edge for the session's workflow type
- **AND** the phase number SHALL be derived from the phase name (no separate `--phase-number` argument is required)

#### Scenario: Complete-round is atomic and invariant-checked

- **WHEN** an agent pipes round metadata to `ocr state complete-round --stdin`
- **THEN** the command SHALL, in one transaction, validate the metadata, assert the session has reached `synthesis`, write `round-meta.json`, append a `round_completed` event, advance `current_round`, and transition the phase to `complete`
- **AND** if any precondition fails, the command SHALL make no changes and exit with the invariant-unmet code
- **AND** re-running it for an already-completed round SHALL be a safe no-op

#### Scenario: Complete-map is atomic for map runs

- **WHEN** an agent pipes map metadata to `ocr state complete-map --stdin`
- **THEN** the command SHALL atomically write `map-meta.json`, append a `map_completed` event for the current map run, and transition the phase to `complete`

#### Scenario: Finish refuses to close an incomplete session

- **WHEN** an agent runs `ocr state finish`
- **AND** the current round has no `round_completed` event
- **THEN** the command SHALL refuse with the invariant-unmet code and SHALL NOT close the session

#### Scenario: Finish with abort records an explicit reason

- **WHEN** an agent runs `ocr state finish --abort`
- **THEN** the session SHALL be closed with a `session_aborted` event
- **AND** the closed session SHALL never be reported as a successful completion

#### Scenario: Status reports completeness and what is missing

- **WHEN** an agent runs `ocr state status --json`
- **THEN** the command SHALL return the session's `completeness_state`, per-obligation booleans, and a `next_action` string describing how to finish

---

### Requirement: State Command Exit Code Taxonomy

State lifecycle commands SHALL use a stable, documented exit-code taxonomy so that an orchestrating agent can branch on the failure class without parsing prose.

#### Scenario: Distinct codes per failure class

- **WHEN** a state command fails
- **THEN** it SHALL exit with `2` for usage errors, `3` for ambiguous session resolution, `4` for session-not-found, `5` for an illegal phase transition, `6` for an unmet invariant, `7` for schema-invalid input, and `8` for database-busy past the retry budget
- **AND** it SHALL exit `0` only on success

#### Scenario: Ambiguity is a typed refusal

- **GIVEN** more than one active session exists and no `--session-id` is provided
- **WHEN** a state command resolves the session
- **THEN** it SHALL exit with code `3` and name the candidate sessions

#### Scenario: Busy is the retry signal

- **WHEN** a transaction surfaces `SQLITE_BUSY` past the bounded retry budget
- **THEN** the command SHALL exit with code `8`, signalling the orchestrator to wait briefly and retry the same call

## REMOVED Requirements

### Requirement: OCR State Round-Complete Command

**Reason**: v2.0 is a direct cutover — the `ocr state round-complete` (and `transition` / `map-complete` / `init` / `close`) subcommands were deleted, not deprecated. The atomic `ocr state complete-round` porcelain fully replaces it with one transactional, invariant-checked commit.

**Migration**: orchestrators call `ocr state complete-round --stdin`. Invoking a retired verb exits `2` (usage) with a notice naming its replacement; no deprecation shim remains.
