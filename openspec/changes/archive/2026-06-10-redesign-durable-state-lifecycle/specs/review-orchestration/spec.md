## ADDED Requirements

### Requirement: Atomic Completion Contract

The orchestrating Tech Lead SHALL finalize rounds and close sessions exclusively through the atomic state porcelain (`ocr state complete-round` / `complete-map` / `finish`), so that completion is always invariant-checked and a workflow can never be reported complete before its work is done.

#### Scenario: Round finalized via the atomic command

- **GIVEN** the orchestrator has produced `final.md` and round metadata for the current round
- **WHEN** it finalizes the round
- **THEN** it SHALL pipe the metadata to `ocr state complete-round --stdin` (which atomically records the artifact, the `round_completed` event, the round advance, and the transition to `complete`)
- **AND** it SHALL NOT rely on a sequence of separate `transition` + `round-complete` + `close` calls that can partially apply

#### Scenario: Session closed only when complete

- **WHEN** the orchestrator ends a workflow
- **THEN** it SHALL call `ocr state finish`, which refuses to close a session whose current round is not complete
- **AND** if the workflow is being abandoned, it SHALL call `ocr state finish --abort`, recording a non-success terminal state

#### Scenario: Resume diagnoses what is missing

- **GIVEN** the orchestrator resumes a session that may have ended prematurely
- **WHEN** it inspects state
- **THEN** it SHALL call `ocr state status --json` to obtain the `completeness_state` and the unmet obligations
- **AND** it SHALL act on the reported `next_action` rather than inferring state from filesystem inspection
