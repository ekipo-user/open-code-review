# Tasks: Directional Verdict ↔ Blocker-Count Consistency

## 1. CLI directional gate

- [x] 1.1 In `packages/shared/persistence/src/state/round-meta.ts`, add the verdict ↔ blocker-count direction check using `resolveRoundCounts(meta).blockerCount` (the deduplicated count, NOT raw `deriveCounts().blocker`): `REQUEST CHANGES` ⟹ count ≥ 1, `APPROVE` ⟹ count = 0, `NEEDS DISCUSSION` unconstrained
- [x] 1.2 On violation, exit `SCHEMA_INVALID`, write nothing, and emit a message naming both the verdict and the blocker count
- [x] 1.3 Tests in `packages/shared/persistence/src/state/__tests__/state.test.ts`: APPROVE+blocker → reject; REQUEST CHANGES+0 blockers → reject; NEEDS DISCUSSION+blocker → accept; APPROVE+0 blockers → accept; REQUEST CHANGES+1 blocker → accept; **APPROVE + raw blocker tally ≥1 but `synthesis_counts.blockers=0` → accept** (no contradiction with the dedup cross-check)

## 1a. Dashboard legacy mismatch hint

- [x] 1a.1 In `packages/dashboard/src/client/components/markdown/verdict-banner.tsx`, render a non-destructive "verdict/finding mismatch" hint when the stored verdict and `resolveRoundCounts().blockerCount` disagree in direction; no row rewrite
- [x] 1a.2 Test: legacy `APPROVE` + blocker count ≥1 → hint shown; consistent row → no hint

## 2. Synthesizer consistency (source-of-truth in packages/agents)

- [x] 2.1 In `packages/agents/skills/ocr/references/*` and `final-template.md`, instruct the synthesizer to choose the verdict and blocker-class findings together per the direction rule
- [x] 2.2 Run `nx run cli:update` to sync `.ocr/`

## 3. Validation

- [x] 3.1 `openspec validate enforce-verdict-count-direction --strict` passes
- [x] 3.2 Full suite green; no regression in the existing enum / title / count checks
