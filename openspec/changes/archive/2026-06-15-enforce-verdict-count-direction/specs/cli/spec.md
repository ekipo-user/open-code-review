## MODIFIED Requirements

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
- **Directional verdict ↔ blocker-count cross-check** — the recorded `verdict`
  SHALL be consistent with the **blocker count**, where the blocker count is the
  single deduplicated value `resolveRoundCounts(meta).blockerCount` from
  `@open-code-review/platform` (which prefers `synthesis_counts.blockers` when
  present, else derives the `blocker`-category tally) — NOT the raw
  `deriveCounts().blocker` tally. "Blocker" here is exactly the canonical
  `blocker` finding category (one of `blocker / should_fix / suggestion /
  style`); `should_fix` is residual work, not a blocker. The rule:
  - `REQUEST CHANGES` SHALL require a blocker count ≥ 1;
  - `APPROVE` SHALL require a blocker count of 0;
  - `NEEDS DISCUSSION` SHALL impose no blocker-count constraint.
  Because the blocker count is the deduplicated `resolveRoundCounts` value, a
  round whose raw `blocker`-category tally is ≥ 1 but whose
  `synthesis_counts.blockers` legitimately deduplicates to 0 is treated as
  having 0 blockers — consistent with the sibling "Deduplicated synthesis count
  is accepted" scenario, so the two checks never contradict each other. A
  violation is rejected with the same `SCHEMA_INVALID` posture (no file, no
  event), and the error message SHALL name both the verdict and the offending
  blocker count.

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

#### Scenario: APPROVE with a non-zero blocker count is rejected
- **WHEN** an agent pipes round metadata whose `verdict` is `APPROVE` but whose `resolveRoundCounts().blockerCount` is ≥ 1
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code and write nothing
- **AND** the error message SHALL name the verdict and the offending blocker count

#### Scenario: REQUEST CHANGES with a zero blocker count is rejected
- **WHEN** an agent pipes round metadata whose `verdict` is `REQUEST CHANGES` but whose `resolveRoundCounts().blockerCount` is 0
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code and write nothing

#### Scenario: APPROVE with blocker findings deduplicated to zero is accepted
- **WHEN** an agent pipes round metadata whose `verdict` is `APPROVE`, whose findings include `blocker`-category entries (raw tally ≥ 1), but whose `synthesis_counts.blockers` legitimately deduplicates to 0
- **THEN** the directional check SHALL use the deduplicated `resolveRoundCounts().blockerCount` of 0 and SHALL PASS
- **AND** this SHALL be consistent with the "Deduplicated synthesis count is accepted" scenario (no contradiction between the two checks)

#### Scenario: NEEDS DISCUSSION is unconstrained on blocker count
- **WHEN** an agent pipes round metadata whose `verdict` is `NEEDS DISCUSSION`, with any blocker count
- **THEN** the directional verdict ↔ blocker-count check SHALL pass (subject to the other checks)

#### Scenario: Valid canonical verdict completes the round
- **WHEN** an agent pipes round metadata with a canonical `verdict`, titles meeting the floor, consistent counts, and a verdict directionally consistent with the deduplicated blocker count
- **THEN** `complete-round` SHALL validate, write `round-meta.json`, append the `round_completed` event, advance the round, and transition the phase — all in one transaction
