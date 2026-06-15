# Change: Directional Verdict ↔ Blocker-Count Consistency

## Why

The canonical 3-state verdict contract (`add-canonical-verdict-contract`, now
shipped) closed the off-vocabulary hole: `complete-round` rejects any verdict
outside `APPROVE | REQUEST CHANGES | NEEDS DISCUSSION`, enforces a finding-title
floor, and runs a `synthesis_counts` cross-check. But that cross-check is
**count-internal only** — it asserts each `synthesis_counts.X` is `≥ 0` and `≤`
the tally derived from `findings[].category` (catching inflation/dedup). It does
**not** check that the recorded verdict points the **same direction** as the
findings.

So a round can still validate while being self-contradictory:

- `APPROVE` (mergeable) recorded alongside one or more `blocker`-category
  findings — the merge gate says "land it" while the findings say "must fix
  first"; or
- `REQUEST CHANGES` (blocked on required work) recorded with **zero**
  blocker-class findings — the gate blocks the merge but points to nothing that
  must change.

This is the *same denormalization class* the verdict contract set out to kill,
one axis over: the merge decision and the blocker count are two views of one
truth that are currently free to disagree. The fix is the last directional layer
on the already-shipped validator, plus making the synthesizer produce a
consistent pair in the first place.

## What Changes

- **CLI directional gate at `ocr state complete-round`.** Extend the existing
  `Round Metadata Validation Contract` with a verdict ↔ blocker-count direction
  check. The blocker count is the single **deduplicated**
  `resolveRoundCounts(meta).blockerCount` from `@open-code-review/platform`
  (which honors `synthesis_counts.blockers`) — explicitly NOT the raw
  `deriveCounts().blocker` tally, so the new check can never contradict the
  already-shipped "deduplicated synthesis count is accepted" rule. "Blocker" is
  exactly the canonical `blocker` category (`should_fix` is residual work, not a
  blocker):
  - `REQUEST CHANGES` SHALL require a blocker count **≥ 1** (there must be
    something to block on);
  - `APPROVE` SHALL require a blocker count of **0** (a mergeable gate cannot
    coexist with a must-fix);
  - `NEEDS DISCUSSION` carries **no** blocker-count constraint (undecided pending
    a human question).
  A violation exits with the existing `SCHEMA_INVALID` code and writes nothing,
  so the orchestrator self-corrects and retries — identical failure posture to
  the enum/title/count checks already in the contract.
- **Synthesizer produces a consistent pair.** Tighten `Final Review Synthesis`
  so the verdict and the blocker-class findings are chosen together to satisfy
  the same direction rule, so the gate is a backstop, not the first line.

## Non-Goals

- No new verdict states, no change to the residual-work model (follow-ups /
  suggestions remain finding categories surfaced as a render-time chip).
- No change to the count-derivation helper itself — this only *compares* against
  it.
- No destructive migration. Legacy rows that violate the new direction rule are
  not rewritten. Note that a direction-contradictory legacy row (e.g. `APPROVE`
  with a non-zero blocker count) is *on-vocabulary*, so the shipped
  `normalizeVerdict` read path passes it through unchanged — the dashboard would
  render an `APPROVE` badge beside a blocker count. This proposal adds a small
  **render-time mismatch hint** (a "verdict/finding mismatch" chip on rows where
  the verdict and the deduplicated blocker count disagree) rather than rewriting
  the row; new rows are gated by the CLI check and the small legacy population
  ages out as clean runs overwrite it.

## Impact

- Affected specs:
  - `cli` — **MODIFIED** `Round Metadata Validation Contract` (add the
    directional verdict ↔ blocker-count layer, bound to
    `resolveRoundCounts().blockerCount`).
  - `review-orchestration` — **MODIFIED** `Final Review Synthesis` (verdict and
    blocker findings chosen consistently).
  - `dashboard` — **ADDED** `Legacy Verdict/Finding Mismatch Hint` (render-time
    hint for pre-gate contradictory rows).
- Affected code (apply stage):
  - `packages/shared/persistence/src/state/round-meta.ts` — the directional check,
    using `resolveRoundCounts().blockerCount` from
    `@open-code-review/platform` (introduced by the verdict change).
  - `packages/dashboard/src/client/components/markdown/verdict-banner.tsx` — the
    render-time mismatch hint.
  - `packages/agents/skills/ocr/references/*` + `final-template.md` — synthesis
    guidance (edit in `packages/agents/`, then `nx run cli:update`).
- No schema migration; `round-meta.json` stays `schema_version: 1` (this tightens
  the relationship between existing fields, not their shape).
