## MODIFIED Requirements

### Requirement: Final Review Synthesis

The system SHALL synthesize individual reviews and discourse into a prioritized final review.

The review verdict SHALL be drawn from a closed, canonical 3-state vocabulary representing the **merge gate** only: `APPROVE` (mergeable), `REQUEST CHANGES` (blocked on required work), or `NEEDS DISCUSSION` (undecided pending a human question). Residual work — follow-ups and suggestions — SHALL NOT be expressed as verdict states; it is carried by finding **category** (`blocker / should_fix / suggestion / style`) and the derived per-round counts. The synthesizer SHALL NOT emit composite or off-vocabulary verdicts (e.g. `accept_with_followups`, `approve_with_suggestions`).

#### Scenario: Confidence weighting
- **GIVEN** findings from multiple sources
- **WHEN** synthesis occurs
- **THEN** findings SHALL be weighted by:
  1. Redundancy consensus (found by multiple runs)
  2. Cross-reviewer consensus (found by different reviewers)
  3. Discourse confirmation
  4. Severity

#### Scenario: Deduplication
- **GIVEN** the same issue found by multiple reviewers
- **WHEN** synthesis occurs
- **THEN** the issue SHALL appear once with sources noted

#### Scenario: Final review structure
- **GIVEN** synthesis is complete
- **WHEN** final review is generated
- **THEN** it SHALL include:
  - Summary
  - Verdict (APPROVE | REQUEST CHANGES | NEEDS DISCUSSION)
  - Must Fix (Critical/High severity)
  - Should Fix (Medium severity)
  - Consider (Low/Note severity)
  - What's Working Well
  - Discussion Notes

#### Scenario: Verdict is a closed merge-gate vocabulary
- **GIVEN** synthesis is complete and an outcome must be recorded
- **WHEN** the verdict is chosen
- **THEN** it SHALL be exactly one of `APPROVE`, `REQUEST CHANGES`, or `NEEDS DISCUSSION`
- **AND** the presence of non-blocking residual work (follow-ups, suggestions) SHALL NOT change the verdict away from `APPROVE`
- **AND** that residual work SHALL be represented as findings with category `should_fix`, `suggestion`, or `style`
