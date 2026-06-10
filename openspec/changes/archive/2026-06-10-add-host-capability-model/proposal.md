# Change: Host-neutral Phase 4 — reviewers run on any AI CLI, not just Claude

## Why

The review skill's Phase 4 told the orchestrator to spawn reviewer sub-agents via the host's Task tool and pass per-instance models via "Claude Code subagent `model:` frontmatter" (issue #28). Hosts without a Task tool (Gemini CLI, Codex) had no defined path, so a review or custom-reviewer flow started on those hosts effectively assumed Claude Code. This makes the skill instructions host-neutral and gives every host a first-class way to run Phase 4.

## What Changes

- The skill (`SKILL.md`, `workflow.md`, `reviewer-task.md`) presents two first-class Phase-4 strategies selected by host capability: spawn parallel sub-agents (hosts with a Task/sub-agent primitive), or run reviewers **sequentially** as fresh passes in the same conversation (hosts without one). Claude Code becomes an example, not the assumed host.
- `AIToolConfig` gains a `hostCapabilities` declaration (`subagentSpawn`, `perTaskModel`) as the install-time source of truth, with a conservative default for undeclared hosts.
- New `ocr host capabilities` command lets the skill (or a user) query, per tool, whether the host can spawn sub-agents and vary the model per task, plus the implied Phase-4 strategy. This is the regression guard ensuring no host silently defaults to Claude semantics.
- The runtime adapter interface gains `supportsSubagentSpawn` (Claude Code `true`, OpenCode `true`), agreeing with the install-time `hostCapabilities`, so the dashboard-orchestrated path can later select the strategy programmatically.
- This is consistent with the existing "OCR Does Not Own Phase 4 Process Spawning" requirement: sequential reviewers run inside the host's own process; OCR still does not fork per-reviewer adapters. (The deeper OCR-orchestrated child-CLI spawning — true parallelism + per-persona models on no-Task hosts — is the separate `evolve-phase4-host-aware-spawning` change that absorbs issue #27.)

## Impact

- Affected specs: `review-orchestration`, `dashboard`, `cli`
- Affected code: `packages/cli/src/lib/config.ts` (`hostCapabilities`, `getHostCapabilities`), `packages/cli/src/commands/host.ts` (new), `packages/cli/src/index.ts`, `packages/agents/skills/ocr/SKILL.md`, `packages/agents/skills/ocr/references/workflow.md`, `packages/agents/skills/ocr/references/reviewer-task.md` (synced to `.ocr/` via `nx run cli:update`), `packages/dashboard/src/server/services/ai-cli/types.ts`, `claude-adapter.ts`, `opencode-adapter.ts`
