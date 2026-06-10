# Change: Evolve Phase 4 spawning to a host-capability-driven model

> **Status: proposed (not yet implemented).** This change records the sanctioned
> architecture and build plan for true host-aware Phase-4 spawning. It is the
> follow-up to `add-host-capability-model` and absorbs the open scope of issue
> #27. Do not archive until implemented.

## Why

OCR's review identity is "works across all AI CLIs," but Phase 4 was built Claude-first. The ratified requirement *"OCR Does Not Own Phase 4 Process Spawning"* assumes the host has a Task tool and makes the host AI responsible for spawning reviewer sub-agents. That is correct for Claude Code, but leaves hosts **without** a sub-agent primitive (Gemini CLI, Codex) with only the sequential, single-model fallback (shipped in `add-host-capability-model`). Those hosts get neither parallelism nor per-persona models — making them second-class, and leaving issue #27 (per-persona model selection) unsolved for them.

The right model is **capability-driven**: keep host self-spawning where it exists (Claude, OpenCode — unchanged), and let OCR's command-runner orchestrate Phase 4 by spawning one child CLI per reviewer **only** for hosts that cannot self-spawn. Per-reviewer child spawning gives true parallelism and a genuine per-reviewer `--model`, which resolves #27 even on hosts with no per-task model primitive.

## What Changes

- **BREAKING (supersedes a ratified requirement):** replace *"OCR Does Not Own Phase 4 Process Spawning"* with *"Phase 4 Spawning Is Host-Capability-Driven"*. The blanket prohibition becomes conditional: OCR still does NOT fork per-reviewer processes for hosts whose adapter reports `supportsSubagentSpawn = true` (the host self-spawns); but for `supportsSubagentSpawn = false` hosts, OCR's command-runner MAY spawn one child CLI per reviewer.
- Add `spawnReviewer(SpawnReviewerOptions)` to `AiCliAdapter` for isolated per-reviewer child spawns (own prompt, own `--model`, read-leaning tool set), reusing the existing stream-parse + `ocr session` journal pipeline and a bounded concurrency pool.
- Add new runtime adapters for Gemini CLI and Codex (`spawn` + NDJSON `parseLine` + golden fixtures).

## Build Sequence (tasks.md)

Staged so each step is independently reviewable; see `design.md` for the architecture and the #28/#27 seam.

## Impact

- Affected specs: `review-orchestration` (supersede the spawning requirement), `dashboard` (adapter `spawnReviewer` + command-runner fan-out)
- Affected code (when implemented): `packages/dashboard/src/server/services/ai-cli/types.ts`, new `gemini-adapter.ts` / `codex-adapter.ts`, `packages/dashboard/src/server/socket/command-runner.ts`
- Depends on: `add-host-capability-model` (capability flags + `ocr host capabilities`)
