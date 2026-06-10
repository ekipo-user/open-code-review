## ADDED Requirements

### Requirement: Atomic Round Completion Lifecycle

Completing a review round SHALL be a single atomic operation that finalizes all of its facts together, so a round can never be left partially completed.

#### Scenario: All-or-nothing completion

- **WHEN** a round is completed via `ocr state complete-round`
- **THEN** the round metadata, the `round_completed` event, the `current_round` advance, and the transition to the `complete` phase SHALL commit together in one transaction
- **AND** a failure at any step SHALL leave the session exactly as it was before the call

#### Scenario: Completion requires the workflow path was walked

- **GIVEN** a review session that has not reached the `synthesis` phase
- **WHEN** `ocr state complete-round` is invoked
- **THEN** the command SHALL refuse with the invariant-unmet code
- **AND** because reaching `synthesis` requires legal graph transitions through analysis, reviews, aggregation, and discourse, a completed round implies the workflow path was actually walked

---

### Requirement: Invariant-Checked Session Finish

A session SHALL NOT be marked closed-as-complete unless its current round/run is genuinely complete; abandonment SHALL be recorded as a distinct, non-success terminal state.

#### Scenario: Finish blocked on incomplete round

- **GIVEN** a session whose current round has no `round_completed` event
- **WHEN** `ocr state finish` runs without `--abort`
- **THEN** the session SHALL remain open and the command SHALL report the unmet obligation

#### Scenario: Abort is a recorded, non-success terminal

- **WHEN** `ocr state finish --abort` runs
- **THEN** the session SHALL close with a `session_aborted` event
- **AND** no consumer SHALL report the aborted session as a successful completion

## MODIFIED Requirements

### Requirement: Session State Tracking

The system SHALL maintain session lifecycle in SQLite, where the `orchestration_events` log is authoritative and the `sessions` row is a projection derived from it. Lifecycle facts SHALL NOT be written to `sessions` independently of the event that justifies them, and `state.json` SHALL NO LONGER be written.

#### Scenario: State stored in SQLite

- **GIVEN** a new review session begins
- **WHEN** the session is initialized via `ocr state begin`
- **THEN** the system SHALL insert a `session_created` event and the derived `sessions` projection row in one transaction
- **AND** it SHALL NOT write `state.json`

#### Scenario: Projection columns

- **GIVEN** a session is in progress
- **WHEN** the `sessions` projection row is read
- **THEN** it SHALL contain `id`, `branch`, `status`, `workflow_type`, `current_phase`, `phase_number`, `current_round`, `current_map_run`, `started_at`, `updated_at`, and `session_dir`
- **AND** each of these values SHALL be consistent with the session's `orchestration_events`

#### Scenario: Lifecycle is event-derived

- **GIVEN** lifecycle state is needed (phase, status, round)
- **WHEN** a consumer reads it
- **THEN** the value SHALL come from the `sessions` projection, which is maintained transactionally from the event log
- **AND** filesystem-derived state SHALL be used only by reconciliation for legacy rows that predate the event log

#### Scenario: State updates at phase transitions

- **GIVEN** a review progresses through phases
- **WHEN** transitioning to a new phase
- **THEN** the orchestrating agent SHALL call `ocr state advance`, which appends a `phase_transition` event and updates the projection in one transaction BEFORE work on the phase begins
- **AND** no `state.json` side-effect SHALL be written

#### Scenario: CLI progress tracking

- **GIVEN** a session exists in SQLite
- **WHEN** `ocr progress` is invoked
- **THEN** it SHALL read the `sessions` projection for progress display including current round
- **AND** it SHALL display "Waiting for session..." when no session state exists

---

### Requirement: State Reconciliation

The system SHALL treat the SQLite event log as authoritative and SHALL reconcile legacy or drifted state by deriving truth from events and filesystem artifacts, healing the projection automatically.

#### Scenario: Event log is authoritative

- **GIVEN** a session exists in SQLite
- **WHEN** any consumer needs lifecycle state
- **THEN** the system SHALL derive it from the event log via the `sessions` projection
- **AND** filesystem artifacts SHALL be parsed into content tables but SHALL NOT override lifecycle

#### Scenario: Legacy row without events is reconciled

- **GIVEN** a legacy `sessions` row or session directory lacking lifecycle events
- **WHEN** reconciliation runs (during migration or via `ocr state reconcile`)
- **THEN** it SHALL synthesize completion events from provable artifacts (e.g. a present `final.md`)
- **AND** where completion cannot be proven, it SHALL emit a `session_legacy_import` reason event rather than fabricate completion

#### Scenario: Stale active legacy session is auto-closed

- **GIVEN** a legacy session left `active` with no recent events and no in-flight dependents
- **WHEN** reconciliation or the periodic sweep runs
- **THEN** it SHALL close the session with a `session_auto_closed_stale` event

#### Scenario: Empty round directory does not alter lifecycle

- **GIVEN** a user manually creates `rounds/round-2/` with no contents
- **WHEN** FilesystemSync runs
- **THEN** content tables MAY record the empty round
- **AND** the `sessions` lifecycle projection SHALL NOT be modified (only `ocr state` commands change lifecycle)
