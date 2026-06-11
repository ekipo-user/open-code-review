> Tasks are intentionally unchecked — this change is proposed, not yet built.

## 1. Adapter contract

- [ ] 1.1 Add `SpawnReviewerOptions` (extends `SpawnOptions` with `persona`, `instanceIndex`, `name`, `workflowId`, resolved `model`)
- [ ] 1.2 Add `spawnReviewer(opts): SpawnResult` to `AiCliAdapter`
- [ ] 1.3 Default implementation derivable from `spawn()` for adapters that don't override; unit-test against the real Claude/OpenCode adapters

## 2. command-runner Phase-4 fan-out (capability-gated)

- [ ] 2.1 When the active adapter reports `supportsSubagentSpawn = false`, orchestrate Phase 4 in `command-runner.ts`: read `ocr team resolve --json`, spawn one child per instance via `spawnReviewer` with its `--model`
- [ ] 2.2 Reuse the existing stream-parse pipeline and `ocr session start-instance/bind-vendor-id/beat/end-instance` journaling for each child
- [ ] 2.3 Bound concurrency with the existing `MAX_CONCURRENT` pool; make per-reviewer concurrency configurable
- [ ] 2.4 Leave the `supportsSubagentSpawn = true` path (Claude, OpenCode) unchanged — host self-spawns

## 3. New runtime adapters (require real CLI integration)

- [ ] 3.1 `gemini-adapter.ts` — `spawn`, `createParser`/`parseLine`, resume helpers; golden NDJSON fixtures recorded from real Gemini CLI output. Model listing is NOT an adapter concern: register a vendor entry in `VENDOR_MODEL_STRATEGIES` (`packages/cli/src/lib/models.ts`) instead — the `model-strategy-agreement` contract test fails until it exists (see update-vendor-model-enumeration)
- [ ] 3.2 `codex-adapter.ts` — same, with Codex fixtures (and its own strategy-table entry)
- [ ] 3.3 Register both in the adapter registry; `doctor` cross-check that a `vendorBinary` with no adapter is informational, not an error

## 4. Tests

- [ ] 4.1 Capability-class fake adapters (one per strategy row) → assert command-runner routes correctly without real binaries
- [ ] 4.2 Per-persona-model application matrix (Claude frontmatter / child `--model` / sequential single-model + warning)
- [ ] 4.3 Golden-fixture parser tests per new vendor

## 5. Spec

- [ ] 5.1 Supersede "OCR Does Not Own Phase 4 Process Spawning" with the capability-driven requirement (this change's delta)
