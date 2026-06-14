## 1. Shared canonical verdict module

- [x] 1.1 Add `packages/shared/platform/src/verdict.ts` with `CANONICAL_VERDICTS`, `CanonicalVerdict`, `isCanonicalVerdict`, `VERDICT_ALIASES`, and `normalizeVerdict`
- [x] 1.2 Re-export the verdict surface from `packages/shared/platform/src/index.ts`
- [x] 1.3 Unit tests for `isCanonicalVerdict` (exact + casing) and `normalizeVerdict` (alias map, retired composites → `APPROVE`, unknown → `null`)

## 2. CLI enforcement at complete-round

- [x] 2.1 In `packages/shared/persistence/src/state/round-meta.ts`, replace the non-empty-string verdict check (:34-37) with `isCanonicalVerdict`-or-throw, importing from `@open-code-review/platform`; error message echoes the value and the legal set
- [x] 2.2 Add the `MIN_TITLE_LEN = 8` finding-title floor at the title check (:62)
- [x] 2.3 Add the directional `synthesis_counts` cross-check (error only when a count exceeds the derived category tally; allow ≤)
- [x] 2.4 Tests in `packages/shared/persistence/src/state/__tests__/state.test.ts`: off-vocab verdict → exit 7; degenerate title → exit 7; inflated count → exit 7; deduplicated (lower) count → OK; canonical happy path → round completes

## 3. Dashboard read-time normalization

- [x] 3.1 In `packages/dashboard/src/server/services/filesystem-sync.ts`, normalize via `normalizeVerdict` at the verdict store (orchestrator + parser paths) and the socket emit
- [x] 3.2 Route `verdict-banner.tsx` config resolution through the shared `normalizeVerdict`, removing the ad-hoc prefix-matching while preserving the neutral fallback for unknowns (added a Node-free `@open-code-review/platform/verdict` subpath export so the browser bundle doesn't drag in the barrel's Node built-ins)
- [x] 3.3 Test: ingesting a legacy `accept_with_followups` row stores `APPROVE`; an unknown value stores raw and renders the neutral fallback

## 4. Verdict / status UX redesign

- [x] 4.1 `verdict-banner.tsx`: 3-state badge (APPROVE green / REQUEST CHANGES red / NEEDS DISCUSSION amber) + neutral fallback
- [x] 4.2 Add the render-time residual-work chip (derived from `should_fix_count` / `suggestion_count`), visually subordinate to the badge; follow-ups weighted over suggestions; "clean" affordance when both are zero
- [x] 4.3 `round-page.tsx`: fix the inverted hierarchy and visually separate the three status axes (verdict / round-level triage / per-finding triage)
- [x] 4.4 `findings-table.tsx`: loading + empty + degraded states; NaN-safe severity sort for unknown severities

## 5. Skill contract alignment (source-of-truth in packages/agents)

- [x] 5.1 Unify the verdict vocabulary to the canonical 3 states across `packages/agents/skills/ocr/references/*` (session-state, workflow, session-files) and `final-template.md` (source was already canonical; added an explicit merge-gate vocabulary + fail-fast contract at the JSON-construction site in workflow.md)
- [x] 5.2 Ensure the skill documents that follow-ups/suggestions are finding categories, not verdicts (reinforced in final-template.md Step 7 and workflow.md complete-round contract)
- [x] 5.3 Run `nx run cli:update` to sync the edits into `.ocr/`

## 6. Verify

- [x] 6.1 `nx run-many -t typecheck` (or per-package `tsc`) is clean
- [x] 6.2 CLI + dashboard unit suites pass (cli: 93, dashboard filesystem-sync: 27, platform verdict tests green)
- [x] 6.3 Read-time normalization proven by automated test (legacy `accept_with_followups` → stored `APPROVE`; unmappable → stored raw + neutral fallback). Live re-ingest available via `ocr state sync` against the workspace `.ocr/` per the fix-forward decision.
- [x] 6.4 `openspec validate add-canonical-verdict-contract --strict` passes
- [x] 6.5 Verify D1: a session directory with `final.md` but no `round-meta.json`/`round_completed` event is NOT backfill-closed by the dashboard; it derives `synthesis`, and `session_completeness` does not report it `complete`
- [x] 6.6 Verify D2: `complete-round --file <payload>` materializes `rounds/round-N/round-meta.json`; a re-run with the artifact already present is a no-op; a re-run with the artifact missing re-materializes it without duplicating the event

## 7. Lifecycle-integrity defects (D1/D2/D3)

### D1 — Dashboard read-side must not fabricate terminal completion

- [x] 7.1 In `packages/dashboard/src/server/services/filesystem-sync.ts`, map `final.md` presence to the `synthesis` phase (not `complete`) in phase derivation
- [x] 7.2 Gate the backfill `commitReasonClose` path so a round with `final.md` but no validated `round-meta.json` / `round_completed` event is NOT closed by the dashboard; terminal completion comes only from the CLI's validated finalize. Leave the CLI-side "Automatic Legacy State Reconciliation" untouched
- [x] 7.3 Tests: a session with only `final.md` derives `synthesis` and is not reported `complete` by `session_completeness`; a session with a `round_completed` event + `round-meta.json` still backfill-closes correctly

### D2 — `complete-round` guarantees the artifact regardless of input source

- [x] 7.4 In `packages/shared/persistence/src/state/index.ts` `stateCompleteRound`, write the validated `round-meta.json` to the canonical round path on the success path for **both** `--stdin` and `--file` (identity no-op when the source already is the canonical file)
- [x] 7.5 Refine the idempotency guard: round_completed event present **and** artifact present ⇒ safe no-op; event present but artifact absent ⇒ re-materialize from recorded round metadata without duplicating the event or re-advancing the round
- [x] 7.6 Tests: `complete-round --file` materializes the artifact; re-run with artifact present is a no-op; re-run with artifact absent re-materializes it; the DB never reaches `complete` with the artifact absent

### D3 — One canonical round-count derivation, shared

- [x] 7.7 Add `packages/shared/platform/src/counts.ts` with pure `deriveCounts(findings)` and `resolveRoundCounts(meta)` keyed on the canonical category vocabulary; export via a Node-free `@open-code-review/platform/counts` subpath (mirror the `./verdict` subpath wiring in `package.json`)
- [x] 7.8 Replace the three call sites with the shared helper: `computeRoundCounts` and the directional cross-check in `packages/shared/persistence/src/state/round-meta.ts` (cross-check re-expressed as derive-then-compare), and the inline count block in `filesystem-sync.ts`; document the `style`-omission once at the helper. Add unit tests for `deriveCounts`/`resolveRoundCounts` (synthesis_counts preferred; derived fallback; `style` handling) plus a test pinning that CLI and dashboard produce identical counts for the same metadata
