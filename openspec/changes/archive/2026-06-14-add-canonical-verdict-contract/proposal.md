# Change: Canonical 3-State Verdict Contract (Merge-Gate) + Enforced Validation

## Why

A round-result page rendered a meaningless "?" badge because the orchestrator
emitted an off-vocabulary verdict, `accept_with_followups`, that nothing
validated and the dashboard couldn't map. The same payload also carried
degenerate findings (`title='s'`, one per reviewer, miscounted).

Root cause is a **modeling error, not a missing validator**: the verdict field
was being used to encode *two orthogonal concepts at once* —

- the **merge gate** ("can this land?": yes / blocked / undecided), and
- the **residual work** ("what is left to do?": follow-ups, suggestions),

— even though residual work is *already* fully represented by finding
**category** (`blocker / should_fix / suggestion / style`) and the per-round
counts. Encoding "with follow-ups" / "with suggestions" in the verdict
**denormalizes** that data: a second source of truth that can drift from the
findings. `accept_with_followups` is exactly that drift. The existing
`review-orchestration` spec already mandates a 3-state verdict
(`APPROVE | REQUEST CHANGES | NEEDS DISCUSSION`), so the orchestrator's output
was already a spec violation — the contract was real but unenforced.

This change makes the 3-state contract **enforceable end to end** and keeps the
residual-work axis where it is normalized (findings + counts), surfaced in the
UI as a render-time chip — so the headline verdict and the finding list can
never contradict each other again.

## What Changes

- **Canonical verdict vocabulary is a closed 3-state enum** — `APPROVE`,
  `REQUEST CHANGES`, `NEEDS DISCUSSION` — defined once in
  `@open-code-review/platform` (already a `workspace:*` dependency of both the
  CLI and the dashboard) and shared across skill → CLI → dashboard.
- **Residual work stays out of the verdict.** "Follow-ups" (`should_fix`) and
  "suggestions" (`suggestion`/`style`) are NOT verdict states; they are finding
  categories already, surfaced beneath an `APPROVE` headline as a derived
  counts chip. **No `accept_with_followups` / `approve_with_suggestions` state.**
- **CLI fail-fast validation at `ocr state complete-round`**: reject
  off-vocabulary verdicts, reject degenerate finding titles (minimum length),
  and add a *directional* `synthesis_counts` cross-check (a synthesis count may
  be ≤ the derived category tally — legitimate dedup — but never greater). Any
  violation exits with the existing `SCHEMA_INVALID` code and writes nothing, so
  the orchestrator self-corrects and retries.
- **Dashboard read-time normalization**: `normalizeVerdict` maps legacy/aliased
  values (e.g. `accept_with_followups`, `APPROVED`, `LGTM`) to canonical states
  at the ingestion boundary; genuinely unknown values fall back to the existing
  neutral badge rather than a raw "?".
- **Verdict/status UX redesign**: a 3-state verdict badge, a subordinate
  residual-work chip derived from counts, and clear visual separation of the
  three status axes (verdict vs round-level triage vs per-finding triage) that
  were previously confusable. Findings table gains loading / empty / degraded
  states and NaN-safe severity sorting.
- **Skill contract alignment**: unify the verdict vocabulary across all agent
  references and the final-review template to the canonical 3 states (edit in
  `packages/agents/`, then `nx run cli:update`).
- **Fix-forward**: no destructive migration, no DB hand-edits. The existing
  corrupt round row ages out; the next clean review run overwrites it.

### Lifecycle-integrity defects surfaced while finalizing the review of this change

Reviewing this change's own working tree (the pre-release `hotfix/pre-release-review`
session) surfaced three lifecycle/consistency defects that live in the same
write/read boundary this change is hardening. They are folded in here because
they are the *same drift class* — a fact derivable from one source being
re-derived (or fabricated) at a second site that can disagree — and the verdict
work already touches every file involved.

- **D1 — Dashboard must not fabricate terminal completion from `final.md` alone.**
  The dashboard's filesystem-sync reconciler can drive a session to a terminal
  `complete`/closed state from the mere on-disk *presence of `final.md`*,
  emitting a `session_synced` reason event that satisfies the close-guard
  trigger — bypassing the CLI's validated finalize (`round_completed` event +
  validated `round-meta.json`). The result is a session reported `complete` that
  the `session_completeness` view would otherwise flag `closed_without_artifact`.
  The dashboard read-side SHALL treat `final.md` as evidence of the **synthesis**
  phase only, never terminal completion; terminal evidence is the
  `round_completed` event plus a validated `round-meta.json`, which only the CLI
  produces. (This does **not** weaken the CLI-side "Automatic Legacy State
  Reconciliation", which legitimately MAY synthesize a `round_completed` event
  from a provable `final.md` during migration / `ocr state reconcile` — that is a
  write-side reconciler with an audit event, not the dashboard read path.)
- **D2 — `complete-round` SHALL guarantee `round-meta.json` on disk regardless of
  input source.** `ocr state complete-round` writes `round-meta.json` only on the
  `--stdin` path; the `--file` path completes the DB transaction (event + phase
  transition) but never materializes the artifact at the canonical round path,
  and the idempotency guard then treats the round as already-complete and refuses
  to backfill it — yielding a DB-`complete` round with no on-disk artifact (the
  exact `closed_without_artifact`-shaped drift D1 also produces, from the writer
  side). Success SHALL guarantee a validated `round-meta.json` at
  `rounds/round-N/round-meta.json` whether the payload arrived via `--stdin` or
  `--file`; the idempotent re-run SHALL be a no-op **only** when that artifact is
  already present, and SHALL otherwise materialize the missing artifact from the
  recorded round metadata.
- **D3 — One canonical round-count derivation, shared.** The rule "prefer
  `synthesis_counts` (deduplicated) else derive the tally from
  `findings[].category`" is triplicated across `computeRoundCounts`, the new
  directional `synthesis_counts` cross-check loop, and the dashboard's inline
  count block in `filesystem-sync.ts`. This is the *exact denormalization this
  change set out to kill*, one axis over: three implementations of one rule that
  are consistent today and free to drift tomorrow. The derivation SHALL be a
  single pure helper in `@open-code-review/platform` (on a Node-free subpath, the
  same bundle-hygiene discipline as `./verdict`), consumed by the CLI writer and
  the dashboard reader; the directional cross-check SHALL be re-expressed as
  *derive-then-compare* against that one helper. The helper SHALL key off the
  canonical finding-category vocabulary (`blocker / should_fix / suggestion /
  style`), not ad-hoc count-field names.

## Impact

- Affected specs: `review-orchestration` (verdict definition), `cli`
  (complete-round validation; **D2** artifact-materialization guarantee),
  `dashboard` (verdict rendering, ingestion normalization, findings table
  states; **D1** read-side terminal-completion guard), `session-management`
  (**D2** source-agnostic round-metadata write), `sqlite-state` (**D3**
  canonical round-count derivation).
- Affected code:
  - **New**: `packages/shared/platform/src/verdict.ts` (canonical enum +
    `normalizeVerdict`), re-exported from `packages/shared/platform/src/index.ts`.
  - `packages/shared/persistence/src/state/round-meta.ts` (verdict enum enforcement at
    :34-37, min-title rule at :62, directional `synthesis_counts` cross-check at
    :95-108 / `computeRoundCounts`).
  - `packages/dashboard/src/server/services/filesystem-sync.ts` (normalize at
    store :813 and emit :935).
  - `packages/dashboard/src/client/components/markdown/verdict-banner.tsx`,
    `.../features/reviews/round-page.tsx`,
    `.../features/reviews/components/findings-table.tsx` and `finding-row.tsx`
    (3-state badge, residual chip, axis disambiguation, table states).
  - `packages/agents/skills/ocr/references/*` + `final-template.md` (vocabulary
    unification), synced via `nx run cli:update`.
  - **D1**: `packages/dashboard/src/server/services/filesystem-sync.ts` — phase
    derivation (`final.md` → `synthesis`, not `complete`) and the backfill
    `commitReasonClose` path (must not treat `final.md` presence as terminal
    completion).
  - **D2**: `packages/shared/persistence/src/state/index.ts` `stateCompleteRound` — the
    source-gated artifact write and the idempotency guard; both completion
    sources must materialize `round-meta.json`.
  - **D3**: new pure helper in `packages/shared/platform/src/` on a Node-free
    `./counts` subpath; consumed by `packages/shared/persistence/src/state/round-meta.ts`
    (`computeRoundCounts` + the directional cross-check) and
    `packages/dashboard/src/server/services/filesystem-sync.ts`.
- No schema migration; `round-meta.json` stays `schema_version: 1` (this tightens
  the value domain of existing fields, it does not change the shape).
- Backward compatible: `source=parser` rows already use the canonical uppercase
  vocabulary; the one corrupt `source=orchestrator` row renders via the neutral
  fallback until overwritten.
