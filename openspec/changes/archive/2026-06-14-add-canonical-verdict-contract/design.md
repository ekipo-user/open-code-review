## Context

OCR runs two ingestion pipelines keyed by `review_rounds.source`:

- `source=orchestrator` (authoritative): the review skill hand-builds a
  `round-meta.json` (`schema_version: 1`) and pipes it through
  `ocr state complete-round --stdin`; the dashboard ingests it and **skips**
  markdown parsing.
- `source=parser` (fallback): the dashboard parses reviewer `.md` + `final.md`.

A round carries one headline **verdict** plus a set of **findings**, each with a
**category** (`blocker / should_fix / suggestion / style`) and **severity**
(`critical / high / medium / low / info`). The dashboard derives per-round
counts (`blocker_count`, `should_fix_count`, `suggestion_count`).

The verdict field at [round-meta.ts:34-37](packages/shared/persistence/src/state/round-meta.ts)
accepts *any* non-empty string. The orchestrator emitted `accept_with_followups`;
it passed CLI validation, was stored verbatim at
[filesystem-sync.ts:813](packages/dashboard/src/server/services/filesystem-sync.ts),
and rendered as a neutral "?" badge. The same payload had `title='s'` findings
(passing the `trim().length === 0` check at
[round-meta.ts:62](packages/shared/persistence/src/state/round-meta.ts)) and counts that
did not match the findings.

A five-member design board (architect, AI engineer, backend engineer, design
expert, plus a domain-modeling review) examined the verdict taxonomy. After a
first pass landed on a richer 5-state set, the board was reconvened on a sharper
question from the product owner — *"what statuses does a developer need to be
totally confident what to do next?"* — and **unanimously and independently
converged on 3 states**. This document records that decision and its rationale.

## Goals / Non-Goals

**Goals**
- One canonical verdict vocabulary, defined once, enforced at the write boundary
  and tolerated (normalized) at the read boundary.
- Make the verdict↔counts contradiction *unrepresentable*, not merely validated.
- Preserve the optional-vs-committed (suggestion-vs-follow-up) distinction the
  product owner cares about — at the layer where it is actionable (findings),
  not in the headline.
- Fix-forward; no destructive migration.

**Non-Goals**
- No `round-meta.json` schema_version bump (value-domain tightening only).
- No change to the `source=parser` write path (already canonical).
- No DB hand-edits or backfill of the existing corrupt row.
- Not reworking finding categories/severities (already enforced and correct).

## Decisions

### Decision 1 — Verdict is the merge gate; residual work is NOT a verdict

The verdict answers exactly one question — *can this merge?* — with three
mutually exclusive, collectively exhaustive states:

| Verdict | Gate | Developer's next action |
|---|---|---|
| `APPROVE` | open | Merge. (Check the residual-work chip for anything to track.) |
| `REQUEST CHANGES` | blocked | Don't merge — fix the blockers, re-request review. |
| `NEEDS DISCUSSION` | undecided | Don't merge — resolve an open question with a human first. |

"Follow-ups" and "suggestions" are **residual work**, already encoded by finding
`category` (`should_fix`, `suggestion`/`style`) and the derived counts. The UI
composes a presentation label at render time from gate + counts:

```
verdict = APPROVE, should_fix_count > 0   → "Approve · 2 follow-ups"
verdict = APPROVE, suggestion_count > 0   → "Approve · 3 suggestions"
verdict = APPROVE, both 0                 → "Approve — clean"
```

**Why not encode residual work in the verdict (the 4/5-state options):** it
denormalizes a fact already stored in the findings, creating a second source of
truth that can disagree with the first. That disagreement *is* the
`accept_with_followups` bug class. A 3-state gate makes the contradiction
unrepresentable — there is no field in which to express "approve with follow-ups
but zero follow-up findings." Validation (an allow-list) closes the
off-vocabulary hole; this model also closes the semantic-contradiction hole.

**Why `APPROVE WITH SUGGESTIONS` and `ACCEPT WITH FOLLOW-UPS` collapse:** by the
developer-action test, both map to the same action — *merge*. They differ only
in *which finding category* exists, which is a property of the finding, not the
gate. The optional-vs-committed (obligation) distinction is real and preserved —
as the residual-work chip, where follow-ups read with weight and link to tracked
issues and suggestions read muted — but it does not gate the merge, so it is not
a verdict.

**Classifier-reliability corollary:** an LLM orchestrator picking among labels is
running a soft classifier. "Are there blocking findings?" is a crisp,
reproducible boundary. "Optional suggestion vs tracked follow-up?" is mush with
no anchor in the diff, so a richer enum makes the *same code re-reviewed flap*
between labels across runs. Three states with crisp boundaries maximize
reproducibility — and the verdict becomes (near-)derivable from the findings
rather than a second, redundant classification.

### Decision 2 — Canonical enum lives in `@open-code-review/platform`

`@open-code-review/platform` is already a `workspace:*` dependency of both the
CLI ([cli/package.json:96](packages/cli/package.json)) and the dashboard
([dashboard/package.json:39](packages/dashboard/package.json)) and exports
straight from source (no build step to coordinate). New
`packages/shared/platform/src/verdict.ts`:

```ts
export const CANONICAL_VERDICTS = ['APPROVE', 'REQUEST CHANGES', 'NEEDS DISCUSSION'] as const
export type CanonicalVerdict = (typeof CANONICAL_VERDICTS)[number]
export function isCanonicalVerdict(v: string): v is CanonicalVerdict { /* Set.has */ }

// Read-time tolerance for legacy/aliased values (dashboard only).
const VERDICT_ALIASES: Record<string, CanonicalVerdict> = {
  APPROVED: 'APPROVE', LGTM: 'APPROVE', APPROVE_WITH_SUGGESTIONS: 'APPROVE',
  ACCEPT_WITH_FOLLOWUPS: 'APPROVE', 'ACCEPT WITH FOLLOW-UPS': 'APPROVE',
  'CHANGES REQUESTED': 'REQUEST CHANGES', BLOCK: 'REQUEST CHANGES', REJECT: 'REQUEST CHANGES',
  'NEEDS WORK': 'NEEDS DISCUSSION',
}
export function normalizeVerdict(raw: string): CanonicalVerdict | null { /* upper → exact|alias */ }
```

Note the aliases collapse the *retired* richer values to `APPROVE`: a legacy
`accept_with_followups` row was an approve-gate with follow-ups, so it normalizes
to `APPROVE` and its `should_fix_count` drives the chip — no information lost.

### Decision 3 — Validation: hand-rolled, fail-fast, no new dependency

zod is **not** a dependency of any package; the existing validators are
hand-rolled throw-on-first-error (consistent with
[round-meta.ts](packages/shared/persistence/src/state/round-meta.ts) and the install-verified
npm tarball). Keep that pattern. Three additions to `validateRoundMeta`:

1. **Verdict enum** — replace the non-empty-string check at :34-37 with
   `isCanonicalVerdict`-or-throw. The writer is **strict**: it does NOT coerce
   aliases (aliasing is a read-side concern for legacy data). A bad verdict
   throws → `STATE_EXIT.SCHEMA_INVALID` (exit 7) → no file written, no event
   appended → the orchestrator reads the stderr message enumerating the legal
   set and retries. Error message echoes the offending value and the allowed set.
2. **Min title length** — at :62, reject titles below a small floor
   (`MIN_TITLE_LEN`, proposed 8) so `'s'` fails while real titles pass.
3. **Directional `synthesis_counts` cross-check** — `synthesis_counts` are
   *deduplicated* totals, so the legal invariant is `synthesis_counts.X ≤
   derivedCount(X)` and `≥ 0`. A synthesis count *exceeding* the derived tally is
   impossible (you cannot dedup to more than you started with) → hard error. A
   count *lower* is legitimate dedup → allowed. This catches the inflated-count
   symptom without false-positiving on real dedup.

### Decision 4 — Dashboard normalizes on read; does not re-validate structure

The CLI is the authoritative structural validator for `source=orchestrator`.
The dashboard keeps its minimal shape guard at
[filesystem-sync.ts:789](packages/dashboard/src/server/services/filesystem-sync.ts)
and adds `normalizeVerdict(meta.verdict) ?? meta.verdict` at the store (:813) and
emit (:935). Truly unknown strings keep the raw value and render via the existing
"Review Render Tree Degrades Gracefully" neutral fallback. `verdict-banner.tsx`
routes its config lookup through the shared `normalizeVerdict`, collapsing its
ad-hoc prefix-matching.

### Decision 5 — Terminal completion is the CLI's to assert; the dashboard reads `final.md` as `synthesis` only (D1)

**Context.** Finalizing the review of this change exposed a real instance of the
`closed_without_artifact` drift the `sqlite-state` capability was built to make
detectable. The dashboard's filesystem-sync reconciler derives a session's phase
from on-disk artifacts and will *backfill-close* a session it finds on disk via
`commitReasonClose` (a single transactional reason-event-then-status commit). The
reason event it writes — `session_synced` — is on the close-guard's allow-list,
so the close succeeds. The defect is that the reconciler can take this path on
the strength of **`final.md` presence alone**, with no `round_completed` event
and no validated `round-meta.json`. That is precisely a session the
`session_completeness` view would otherwise classify `closed_without_artifact` —
the dashboard manufactures a fake "complete".

**The boundary.** There are two reconcilers, and they are *not* peers:

- The **CLI write-side reconciler** (`ocr state reconcile`, migration) MAY
  synthesize a `round_completed` event from a provable `final.md` and records a
  reconciliation audit event. This is the existing, correct
  "Automatic Legacy State Reconciliation" requirement and is **left untouched** —
  weakening it would defeat legacy import.
- The **dashboard read-side** (filesystem-sync) MAY parse content into tables and
  MAY surface lifecycle, but SHALL NOT *originate* terminal completion. For the
  read side, `final.md` is evidence of the **synthesis** phase, not `complete`.
  Terminal evidence is the `round_completed` event + a validated `round-meta.json`
  — artifacts only the CLI's validated finalize produces.

**Decision.** Map `final.md` → `synthesis` in the dashboard's phase derivation. A
round directory that contains `final.md` but no validated `round-meta.json` /
`round_completed` event SHALL NOT be backfill-closed by the dashboard. The
dashboard's lifecycle mutation stays confined to the CLI-published
`commitReasonClose` primitive (or an `ocr state` child process), and that
primitive's use for *discovery backfill* is scoped to sessions whose completion
is already proven by a terminal artifact event — never inferred from `final.md`.
Why read-side and not a new CLI rule: the asymmetry mirrors Decision 1's
strict-writer/tolerant-reader split — the authoritative completion fact has
exactly one writer (the CLI), and every other surface derives from it rather than
re-deciding it.

### Decision 6 — `complete-round` guarantees the artifact regardless of input source (D2)

**Context.** `stateCompleteRound` writes `round-meta.json` to the canonical round
path only on the `--stdin` branch. The `--file` branch runs the same DB
transaction (validate → `round_completed` event → advance round → phase
`complete`) but never materializes the file, and the idempotency guard — which
treats a round with a `round_completed` event as already-complete — then refuses
to backfill the missing artifact on a re-run. The outcome is a DB-`complete`
round with no on-disk `round-meta.json`: the writer-side twin of D1's drift, and
the precise failure that stranded this change's own review session until the
artifact was hand-placed at the canonical path and re-validated in place.

**Decision.** The artifact write is a *post-condition of success*, not a property
of the input source. On the success path, `complete-round` SHALL write a
validated `round-meta.json` at `rounds/round-N/round-meta.json` whether the
payload arrived via `--stdin` or `--file` (when the source already *is* that
canonical file, the write is a validated no-op / identity). The idempotency
behavior is refined from "round has a `round_completed` event ⇒ no-op" to:

- artifact present **and** event present ⇒ safe no-op (unchanged observable
  behavior);
- event present but artifact **absent** ⇒ re-materialize the artifact from the
  recorded round metadata (self-healing the D2 drift), without duplicating the
  event or re-advancing the round.

This keeps the "re-running for an already-completed round is a safe no-op"
guarantee while making "completed" mean *both* the event and the on-disk artifact
exist — closing the gap by construction rather than by validation.

### Decision 7 — One pure, shared round-count derivation (D3)

**Context.** The rule "prefer `synthesis_counts` (a deduplicated total) else
derive the tally from `findings[].category`" now lives in three places:
`computeRoundCounts`, the directional `synthesis_counts` cross-check loop this
change *adds*, and the dashboard's inline block in `filesystem-sync.ts`. They are
consistent today (both prefer `synthesis_counts`) — even down to producing the
same numbers — but they are two idioms (`sc ? sc.x :` in the CLI, `sc?.x ??` in
the dashboard) maintained by hand. This is the verdict change's own thesis —
*one source of truth so two representations can't disagree* — violated one axis
over.

**Decision.** Extract two pure functions into `@open-code-review/platform` on a
Node-free `./counts` subpath (the same bundle-hygiene discipline that keeps
`node:child_process` out of the browser graph for `./verdict`):

```ts
// derive the per-category tally from the findings list
export function deriveCounts(findings: { category: string }[]): CategoryCounts
// resolve the reported counts: prefer synthesis_counts, else the derived tally
export function resolveRoundCounts(meta: { findings, synthesis_counts? }): CategoryCounts
```

- The helper keys off the **canonical finding-category vocabulary**
  (`blocker / should_fix / suggestion / style`) — *not* ad-hoc count-field names
  or event-metadata keys — so it shares a vocabulary with the verdict/category
  contract rather than inventing a third.
- The CLI writer (`computeRoundCounts`) and the dashboard reader both call
  `resolveRoundCounts`; the inline `filesystem-sync.ts` block is deleted.
- The **directional cross-check becomes derive-then-compare**: compute
  `deriveCounts(findings)` once, then assert each present `synthesis_counts.X ≤
  derived.X` (and `≥ 0`). The new loop folds into the shared helper instead of
  being a third copy of the rule. `style` remains outside the cross-check (it has
  no named synthesis counter) — documented at the helper, so the omission is not
  "fixed" by a future reader.

This is a pure refactor of an already-correct rule into one location: no behavior
change, no schema change. It is the structural fix for the review's sole
`should_fix` finding.

## Risks / Trade-offs

- **Risk: a legitimate future need for a 4th gate state.** → The enum is one
  shared constant; adding a state is a small, deliberate, spec-gated change. We
  are not painting ourselves in — we are refusing to encode *residual work* as a
  gate state, which is a different axis.
- **Risk: `MIN_TITLE_LEN` rejects a legitimately terse title.** → Floor is small
  (8) and tunable; real finding titles comfortably clear it. Surfaced as a board
  open question.
- **Trade-off: strict writer + tolerant reader is two code paths for one
  concept.** → Intentional (Postel): the authoritative writer fails loud so the
  orchestrator self-corrects; the reader tolerates legacy data so old rows still
  render. Both call the *same* shared module, so they cannot define different
  vocabularies.
- **Risk (D1): a session that genuinely completed but predates `round_completed`
  events stops auto-closing in the dashboard.** → That case is exactly what the
  CLI-side "Automatic Legacy State Reconciliation" exists to heal (synthesize the
  event with an audit trail). The dashboard deferring to it is the correct
  separation, not a regression; the legacy path is unchanged.
- **Risk (D2): re-materializing a missing artifact on re-run could overwrite a
  hand-edited file.** → The materialized content is derived from the recorded,
  already-validated round metadata and written only when the canonical artifact
  is *absent*; a present artifact is never rewritten. Round metadata is
  CLI-owned, not a user-edited surface.
- **Trade-off (D3): a new `./counts` subpath export adds a second platform
  entry point.** → Deliberate and consistent with `./verdict`: a pure,
  Node-free module the browser bundle can import without dragging in the barrel's
  Node built-ins. The alternative — leaving three hand-maintained copies — is the
  drift this whole change opposes.

## Migration Plan

Fix-forward; no schema change, no migration, no hand-edits.

- `source=parser` rows already store canonical uppercase verdicts → `normalizeVerdict`
  is identity for them. Untouched.
- The corrupt `accept_with_followups` row stays until overwritten: it does not
  violate any DB constraint and renders via the neutral fallback today; after
  this change it normalizes to `APPROVE` on the next ingest of that file, or is
  fully replaced by the next clean review round (`processRoundMeta` deletes and
  re-inserts findings; user progress is stashed/restored).
- Rollback is trivial: the enum/validation additions are self-contained; reverting
  the commit restores prior behavior with no data implications.

## Resolved Decisions (formerly open questions)

- **`MIN_TITLE_LEN = 8`** (locked). Rejects degenerate titles like `"s"`/`"typo"`
  while real finding titles clear it comfortably.
- **Directional counts cross-check is a hard error only on the high side**
  (locked). Reject when `synthesis_counts.X > derivedCount(X)` (impossible —
  cannot dedup to more than you started with); allow `synthesis_counts.X ≤
  derivedCount(X)` (legitimate cross-reviewer deduplication). No warn-only path.
