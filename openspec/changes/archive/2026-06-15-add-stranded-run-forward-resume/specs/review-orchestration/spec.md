## MODIFIED Requirements

### Requirement: Atomic Completion Contract

The orchestrating Tech Lead SHALL finalize rounds and close sessions exclusively through the atomic state porcelain (`ocr state complete-round` / `complete-map` / `finish`), so that completion is always invariant-checked and a workflow can never be reported complete before its work is done.

To reduce the rate of mid-pipeline strands (a vendor-neutral failure: any turn-ending event between phases leaves the run incomplete), the orchestrator SHOULD drive the pipeline to `complete-round` within the same turn that produced the reviews and SHOULD NOT voluntarily end the turn between phases. This is non-vendor CONTROL guidance; it does not mandate or forbid any host primitive (e.g. background spawning), and recovery via forward-resume remains the backstop for the turn-ending events that cannot be prevented.

On resume, the orchestrator SHALL drive the pipeline **forward** from `current_phase` and SHALL behave identically across hosts. It reads `ocr state status --json`, and when `next_action` is `forward_resume` it re-enters `current_phase` and continues through the remaining phases — the workflow's own phase execution reuses already-produced artifacts (e.g. Phase 4 re-spawns only the reviewers whose outputs are absent) rather than re-producing them. This continuation SHALL behave identically on sub-agent-fanout hosts (where Phase 4 fanned out isolated reviewers) and on sequential-shared-context hosts (where reviewers, discourse, and synthesis are co-resident in one long turn): in both cases resume is in-turn forward progress keyed on `next_action`, never a regression of `current_phase` and never a dependency on any background process outliving the turn.

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

#### Scenario: Forward-resume continues from current_phase

- **GIVEN** the orchestrator resumes a session whose `status --json` reports `next_action = forward_resume` with `current_phase = reviews`
- **WHEN** it continues the workflow
- **THEN** it SHALL re-enter `reviews` and proceed through the remaining phases, the workflow re-spawning only the reviewers whose outputs are absent
- **AND** it SHALL NOT regress `current_phase`

#### Scenario: Resume continuation is host-identical

- **GIVEN** two resumes of equivalent stranded runs, one on a sub-agent-fanout host and one on a sequential-shared-context host
- **WHEN** each orchestrator acts on `next_action = forward_resume`
- **THEN** both SHALL make the same forward progress through the remaining phases driven by the same `ocr state` surface (the `next_action` progression is identical)
- **AND** neither SHALL depend on a background process or cross-process wait that outlives the agent turn
