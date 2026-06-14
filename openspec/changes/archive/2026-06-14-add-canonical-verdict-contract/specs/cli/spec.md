## ADDED Requirements

### Requirement: Round Metadata Validation Contract

The CLI SHALL be the sole enforcement boundary for `round-meta.json` structural
and value-domain validity. At `ocr state complete-round`, validation SHALL run
**before** any write, and any violation SHALL abort the command with the
`SCHEMA_INVALID` exit code, writing no file and appending no event, so an
orchestrating agent can detect the failure, correct the payload, and retry
without leaving partial state.

The validator SHALL enforce, in addition to the existing category and severity
enums:

- **Verdict enum** — `verdict` SHALL be exactly one of the canonical merge-gate
  states `APPROVE`, `REQUEST CHANGES`, `NEEDS DISCUSSION`, sourced from the
  shared `@open-code-review/platform` vocabulary. The writer SHALL NOT coerce
  aliases; an off-vocabulary verdict is rejected.
- **Finding title floor** — each finding `title` SHALL be a string whose trimmed
  length meets a minimum threshold, rejecting degenerate titles such as `"s"`.
- **Directional counts cross-check** — when `synthesis_counts` is present, each
  count SHALL be ≥ 0 and SHALL NOT exceed the tally derived from
  `findings[].category` (a deduplicated synthesis count may be lower than the
  derived tally, but never higher).

#### Scenario: Off-vocabulary verdict is rejected
- **WHEN** an agent pipes round metadata whose `verdict` is not one of `APPROVE`, `REQUEST CHANGES`, `NEEDS DISCUSSION` (e.g. `accept_with_followups`)
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code
- **AND** SHALL write no `round-meta.json` and append no `round_completed` event
- **AND** the error message SHALL echo the offending value and enumerate the legal verdict set

#### Scenario: Degenerate finding title is rejected
- **WHEN** an agent pipes round metadata containing a finding whose trimmed `title` is below the minimum length (e.g. `"s"`)
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code and write nothing

#### Scenario: Inflated synthesis count is rejected
- **WHEN** an agent pipes round metadata whose `synthesis_counts.X` exceeds the count of findings with the corresponding category
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code and write nothing

#### Scenario: Deduplicated synthesis count is accepted
- **WHEN** an agent pipes round metadata whose `synthesis_counts.X` is less than or equal to the derived category tally (legitimate cross-reviewer deduplication)
- **THEN** validation SHALL pass and the round SHALL complete normally

#### Scenario: Valid canonical verdict completes the round
- **WHEN** an agent pipes round metadata with a canonical `verdict`, titles meeting the floor, and consistent counts
- **THEN** `complete-round` SHALL validate, write `round-meta.json`, append the `round_completed` event, advance the round, and transition the phase — all in one transaction

## MODIFIED Requirements

### Requirement: Atomic State Lifecycle Commands

The CLI SHALL provide a semantic, atomic porcelain for workflow lifecycle so that orchestrating agents make correct state updates by default and cannot leave a round partially completed. Each command SHALL perform all of its mutations within a single database transaction. A successful `complete-round` SHALL be a complete result on **both** sides of the boundary — the database transition **and** a validated `round-meta.json` materialized at the canonical round path — regardless of whether the payload arrived via `--stdin` or `--file`, so the database can never report a round `complete` while its on-disk artifact is absent.

#### Scenario: Begin starts or resumes a workflow

- **WHEN** an agent runs `ocr state begin --workflow-type review`
- **THEN** the command SHALL create or resume the session and emit JSON `{session_id, round, phase, completeness}`
- **AND** session resolution SHALL follow `--session-id` → `OCR_DASHBOARD_EXECUTION_UID` → single active session, refusing when more than one active session exists and none is specified

#### Scenario: Advance validates the phase graph and derives the phase number

- **WHEN** an agent runs `ocr state advance --phase reviews`
- **THEN** the command SHALL reject the transition if it is not a legal edge for the session's workflow type
- **AND** the phase number SHALL be derived from the phase name (no separate `--phase-number` argument is required)

#### Scenario: Complete-round is atomic and invariant-checked

- **WHEN** an agent supplies round metadata to `ocr state complete-round` via either `--stdin` or `--file`
- **THEN** the command SHALL, in one transaction, validate the metadata, assert the session has reached `synthesis`, write `round-meta.json` to the canonical round path, append a `round_completed` event, advance `current_round`, and transition the phase to `complete`
- **AND** if any precondition fails, the command SHALL make no changes and exit with the invariant-unmet code
- **AND** on success a validated `round-meta.json` SHALL exist at `rounds/round-N/round-meta.json` irrespective of the input source (when the source already is that canonical file, the write is a validated identity no-op)

#### Scenario: Complete-round never leaves the database ahead of the artifact

- **WHEN** `complete-round` completes successfully for a round
- **THEN** the canonical `round-meta.json` for that round SHALL be present on disk
- **AND** there SHALL be no success path on which the `round_completed` event and phase transition are committed while the artifact is absent

#### Scenario: Re-running complete-round is a safe no-op or self-heals the artifact

- **WHEN** an agent re-runs `complete-round` for a round that already has a `round_completed` event
- **THEN** if the canonical `round-meta.json` is present, the command SHALL be a safe no-op (no duplicate event, no re-advance)
- **AND** if the canonical `round-meta.json` is absent, the command SHALL re-materialize it from the recorded round metadata without appending a duplicate `round_completed` event or re-advancing the round

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
