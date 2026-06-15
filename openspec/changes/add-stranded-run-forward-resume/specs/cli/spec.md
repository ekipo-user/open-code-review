## MODIFIED Requirements

### Requirement: Atomic State Lifecycle Commands

The CLI SHALL provide a semantic, atomic porcelain for workflow lifecycle so that orchestrating agents make correct state updates by default and cannot leave a round partially completed. Each command SHALL perform all of its mutations within a single database transaction. A successful `complete-round` SHALL be a complete result on **both** sides of the boundary — the database transition **and** a validated `round-meta.json` materialized at the canonical round path — regardless of whether the payload arrived via `--stdin` or `--file`, so the database can never report a round `complete` while its on-disk artifact is absent.

`ocr state status --json` SHALL expose a typed, closed `next_action` enum (per `Stranded-Run Next-Action Derivation`) so an orchestrator or watchdog can act on it without parsing prose or inspecting the filesystem. When a session is stranded mid-pipeline (incomplete and its owning turn ended), the status SHALL also report `current_phase`, the ordered `remaining_phases`, and the remaining forward-resume attempts.

#### Scenario: Begin starts or resumes a workflow

- **WHEN** an agent runs `ocr state begin --workflow-type review`
- **THEN** the command SHALL create or resume the session and emit JSON `{session_id, round, phase, completeness}`
- **AND** session resolution SHALL follow `--session-id` → `OCR_DASHBOARD_EXECUTION_UID` → single active session, refusing when more than one active session exists and none is specified

#### Scenario: Begin refuses to re-open an active, incomplete session

- **WHEN** `ocr state begin` would re-open a session that is already `active` and whose current round has no `round_completed` event (a stranded mid-pipeline run)
- **THEN** the command SHALL NOT reset `current_phase` to the workflow's initial phase and SHALL NOT emit a new-round `session_resumed`
- **AND** it SHALL direct the operator to forward-resume instead (the `begin` re-open path is reserved for starting the *next* round on a completed session), so a stranded run can never be silently regressed to `context`

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
- **THEN** the command SHALL return the session's `completeness_state`, per-obligation booleans, and a `next_action` value drawn from the closed enum `{none, finish, forward_resume, abort_or_fresh}` (per `Stranded-Run Next-Action Derivation`)

#### Scenario: Status reports a forward-resumable stall

- **WHEN** an agent runs `ocr state status --json` for a session stranded mid-pipeline (incomplete, owning turn ended, attempts remaining)
- **THEN** the command SHALL report `next_action = forward_resume`, the `current_phase`, the ordered `remaining_phases`, and the remaining forward-resume attempts
- **AND** when no attempts remain or there is no legal forward edge, it SHALL report `next_action = abort_or_fresh` instead

### Requirement: Resume Flag on Existing Review Command

The CLI's `ocr review` command SHALL accept a `--resume <workflow-session-id>` flag that re-spawns the host AI CLI to continue a workflow. This flag is the **optional convenience** path used by the dashboard ("Continue here") and by a terminal handoff; the baseline forward-resume path is simply re-invoking the review skill, which needs no flag, no adapter, and no captured vendor id. When a vendor resume adapter exists for the host (Claude Code and OpenCode today) and a `vendor_session_id` was captured, `--resume` SHALL dispatch through that adapter's resume primitive to preserve conversational continuity; otherwise it SHALL spawn a fresh host turn bound to the existing OCR session so forward progress is still possible. In all cases the re-spawned turn is driven by a fixed CONTROL prompt ("read `ocr state status --json`; act on `next_action`"), never by injected review context, and the prompt is identical across hosts with all delivery differences confined to the adapter.

Resume SHALL be **forward-only and idempotent**: the continuation reads `current_phase` from `ocr state status --json` and drives forward, never regressing `current_phase` and never appending a duplicate terminal event. Resume SHALL acquire the single-writer resume lease (`Forward-Resume of a Stranded Mid-Pipeline Run`) before driving forward, and is bounded by `runtime.forward_resume_max_attempts`; when the cap is exhausted it SHALL refuse and direct the operator to `ocr state finish --abort` or a fresh review.

#### Scenario: Resume by workflow id via the vendor adapter

- **GIVEN** a workflow `sessions` row whose host has a resume adapter and at least one `agent_sessions` row whose `vendor_session_id` is set
- **WHEN** user runs `ocr review --resume <workflow-session-id>`
- **THEN** the system SHALL look up the most recent agent-session for that workflow with a non-null `vendor_session_id`
- **AND** SHALL spawn the host CLI with its vendor-native resume flag, the captured `vendor_session_id`, and the fixed CONTROL prompt

#### Scenario: Resume without a captured vendor id hands off to the baseline skill path

- **GIVEN** a workflow for which no `vendor_session_id` (and thus no resume adapter binding) was ever captured (e.g. it crashed before the first `session_id` event, or ran on a host with no resume adapter)
- **WHEN** user runs `ocr review --resume <workflow-session-id>`
- **THEN** the system SHALL hold the resume lease (so a concurrent auto-resume cannot double-drive) and direct the operator to re-invoke the review skill (`/ocr-review`), whose Phase 0 reads `ocr state status --json` and continues forward from `current_phase` with no adapter — work is preserved, continuity is not required
- **AND** it SHALL exit zero (this is the honest baseline path, not an error)

#### Scenario: Resume is forward-only and reuses prior work

- **GIVEN** a stranded run with `current_phase = reviews`
- **WHEN** resume drives the continuation
- **THEN** the continuation SHALL re-enter `reviews` and proceed forward, the workflow re-spawning only the reviewers whose outputs are absent
- **AND** it SHALL NOT regress `current_phase` or duplicate a terminal event

#### Scenario: Resume refuses once the re-spawn cap is exhausted

- **GIVEN** a stranded run whose current round already has `forward_resume_max_attempts` `forward_resume` lease events
- **WHEN** user runs `ocr review --resume <workflow-session-id>`
- **THEN** the command SHALL refuse, exit non-zero, and direct the operator to `ocr state finish --abort` or to start a fresh review
