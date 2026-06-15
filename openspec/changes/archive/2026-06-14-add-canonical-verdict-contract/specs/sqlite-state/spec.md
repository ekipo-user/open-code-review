## ADDED Requirements

### Requirement: Canonical Round Count Derivation

Per-round finding counts SHALL be derived by a single shared rule, defined once
and consumed by every producer and consumer of those counts, so the count
representation cannot drift between the CLI writer and the dashboard reader. The
rule SHALL be a pure function in `@open-code-review/platform`, exported on a
Node-free subpath (the same bundle-hygiene discipline as the canonical verdict
module) so the browser bundle can import it without dragging in Node built-ins.

The rule SHALL key off the canonical finding-category vocabulary
(`blocker / should_fix / suggestion / style`) — not ad-hoc count-field names or
event-metadata keys — and SHALL be: **prefer the deduplicated `synthesis_counts`
when present; otherwise derive the per-category tally from `findings[].category`.**
The `style` category has no named synthesis counter and SHALL be derived from
findings only; this omission SHALL be documented at the shared helper so it is not
"corrected" at a call site.

The directional `synthesis_counts` cross-check SHALL be expressed as
*derive-then-compare* against this same helper: compute the derived per-category
tally once, then assert each present `synthesis_counts.X` is `≥ 0` and does not
exceed the derived tally. It SHALL NOT be a second, independent transcription of
the derivation rule.

#### Scenario: Single source of truth for the derivation rule

- **WHEN** the CLI writer computes round counts and the dashboard reader computes round counts for the same round metadata
- **THEN** both SHALL call the same shared `@open-code-review/platform` derivation function
- **AND** they SHALL produce identical per-category counts for identical input
- **AND** there SHALL be no second or third in-line copy of the "prefer `synthesis_counts` else derive by category" rule

#### Scenario: synthesis_counts is preferred when present

- **GIVEN** round metadata whose `synthesis_counts` is present
- **WHEN** the shared helper resolves the round counts
- **THEN** it SHALL return the `synthesis_counts` values (the deduplicated totals)

#### Scenario: Counts are derived from categories when synthesis_counts is absent

- **GIVEN** round metadata with no `synthesis_counts`
- **WHEN** the shared helper resolves the round counts
- **THEN** it SHALL derive each count as the tally of findings carrying the corresponding `category`

#### Scenario: Directional cross-check is derive-then-compare

- **WHEN** round metadata with a present `synthesis_counts` is validated
- **THEN** the validator SHALL derive the per-category tally via the shared helper and assert each `synthesis_counts.X` is `≥ 0` and `≤` the derived tally
- **AND** the cross-check SHALL reuse the shared derivation rather than re-implement it
