## Context

Phase 4 instantiates N reviewer personas. Today the dashboard's `command-runner.ts` spawns **one** orchestrator process (the host AI CLI) that runs all 8 phases and does its own Phase-4 fan-out via the host's Task tool. `add-host-capability-model` made the skill prose host-neutral: hosts without a Task tool run reviewers sequentially in a single conversation (single model). This change adds the third, most-capable strategy for those hosts.

## Goals / Non-Goals

- **Goals:** True parallelism and genuine per-reviewer `--model` on hosts with no sub-agent primitive (Gemini, Codex); preserve Claude/OpenCode behavior exactly; keep the dashboard's liveness/resume contract unchanged.
- **Non-Goals:** Changing the Claude/OpenCode path; OCR-coined model aliases (vendor-native strings only); replacing the host AI as the orchestrator for the other 7 phases.

## Decisions

- **Strategy is selected by capability, not hardcoded.** Three strategies:

  | Host class | `supportsSubagentSpawn` | `supportsPerTaskModel` | Phase-4 strategy | Per-persona model |
  |---|---|---|---|---|
  | Claude Code | true | true | host self-spawns via Task tool (**unchanged**) | per-subagent `model:` frontmatter |
  | OpenCode | true | false | host self-spawns sub-agents | uniform model + warning |
  | Gemini / Codex | false | false | **command-runner spawns one child CLI per reviewer** | per-reviewer `--model` (**solves #27**) |

- **`adapter.spawnReviewer()` is separate from `adapter.spawn()`** so a reviewer child can carry its own prompt (assembled from `references/reviewer-task.md`), its own `--model`, a read-leaning tool set, and its own cwd/env — without disturbing orchestrator semantics. It returns the same `SpawnResult` contract so the existing stream-parse pipeline and `ocr session` journaling are reused verbatim. Both strategies therefore produce identical `agent_sessions` rows, keeping the dashboard blind to which one ran.

  - **Interface shape: prefer two interfaces over an optional method or an abstract base class** (issue #28 review Watch-4). `spawnReviewer` only applies to hosts OCR fans out (`supportsSubagentSpawn = false`), so model it as a distinct capability interface (e.g. `ReviewerSpawning`) that those adapters additionally implement, rather than adding an optional `spawnReviewer?` to `AiCliAdapter` (forces every adapter + the runner to null-check) or an abstract base class (forces an inheritance hierarchy onto otherwise-independent adapters). The command-runner narrows via a type guard (`'spawnReviewer' in adapter`) at the one fan-out site.

- **Important-2 carry-over (sequential journaling)**: the sequential fallback this builds on does NOT bind a per-reviewer `vendor_session_id` (reviewers share one parent conversation). Child-spawned reviewers, by contrast, DO each own a host session, so this change restores per-reviewer `bind-vendor-id` and the resume affordances that sequential reviewers lack — a concrete UX win to call out when scoping.

- **The #28/#27 seam.** `add-host-capability-model` (#28) owns capability declaration, the host-neutral skill prose, and the sequential fallback. This change (absorbing #27) owns OCR-orchestrated child spawning and per-reviewer `--model` application. #27's model-resolution chain (`team resolve` → `ReviewerInstance.model`) already exists and is reused as-is.

## Risks / Trade-offs

- **Child CLIs lose the single conversation context** → each child is a fresh agent; it must receive discovered standards / requirements / Tech-Lead guidance as prompt (the `reviewer-task.md` template already assembles exactly this — reuse it as the child prompt). Do not attempt to share history.
- **Concurrency / cost blow-up** (N heavy models in parallel) → bound with the existing `MAX_CONCURRENT` pool; make per-reviewer concurrency configurable; default lower for child-spawn.
- **Unknown vendor stream formats** → each new adapter needs its own NDJSON parser validated against **golden fixtures recorded from real CLI output**. This is the genuine integration cost and the reason this change is staged separately from the #28 bug fixes — it cannot be built correctly from fabricated output.

## Migration Plan

Additive and capability-gated. Claude/OpenCode are unaffected (`supportsSubagentSpawn = true`). The child-spawn path only activates for hosts with a registered adapter reporting `supportsSubagentSpawn = false`; until a Gemini/Codex adapter ships, those hosts continue using the sequential fallback from `add-host-capability-model`. No data migration.

## Open Questions

- Per-reviewer concurrency default and whether it is user-configurable via `config.yaml`.
- Whether ephemeral (`--reviewer`) reviewers child-spawn identically (expected: yes, with a synthesized persona prompt).
