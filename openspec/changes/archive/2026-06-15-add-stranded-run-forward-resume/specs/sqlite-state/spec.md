## ADDED Requirements

### Requirement: Stranded-Run Next-Action Derivation

The system SHALL derive, for any session, the **current phase**, the ordered **remaining phases**, and a typed **next-action**, computed from the `orchestration_events` log and the liveness tables (`agent_sessions`, `command_executions`) — never from filesystem inspection. This derivation SHALL be a single shared pure function (the same single-source-of-truth discipline as the canonical round-count and verdict helpers) so that the CLI `status` command, the dashboard watchdog, and the orchestrator's resume loop all compute the same target and cannot drift.

The **current phase** SHALL be the phase projected from the latest `phase_transition` event for the current round (phase transitions are emitted at phase entry). The **remaining phases** SHALL be the ordered legal-graph phases from `current_phase` through `complete`. The derivation SHALL NOT attempt to assert that any phase's artifact is "validated" — the event log carries no per-phase artifact-evidence event; the only terminal artifact evidence is the `round_completed` (or `map_completed`) event, consistent with `Session Completeness View`.

The **next_action** SHALL be a closed enum, one of:

- `none` — the session is complete (`round_completed` present) or genuinely closed;
- `finish` — the current round/run is complete but the session is still `active` (the `Auto-Finalize` case);
- `forward_resume` — the run is stranded mid-pipeline (`active`, no `round_completed`, owning turn ended, attempts below cap) and forward-resumable from `current_phase`;
- `abort_or_fresh` — the run cannot be advanced forward (the cap is exhausted, or there is no legal forward edge), so the operator must abort or start a fresh review.

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
