## RENAMED Requirements

- FROM: `### Requirement: OCR Does Not Own Phase 4 Process Spawning`
- TO: `### Requirement: Phase 4 Spawning Is Host-Capability-Driven`

## MODIFIED Requirements

### Requirement: Phase 4 Spawning Is Host-Capability-Driven

Phase 4 reviewer instantiation SHALL be selected by host capability, not hardcoded to a single mechanism. For a host whose adapter reports `supportsSubagentSpawn = true` (e.g. Claude Code, OpenCode), OCR SHALL NOT fork reviewer processes from its own command-runner — the host AI CLI spawns sub-agents using its own per-task primitive. For a host whose adapter reports `supportsSubagentSpawn = false` (e.g. Gemini CLI, Codex), OCR's command-runner MAY orchestrate Phase 4 by spawning one child CLI per reviewer instance via `adapter.spawnReviewer`, each with its own resolved `--model`. Regardless of strategy, every instance SHALL be journaled identically through the `ocr session` command family, so downstream consumers cannot distinguish the strategies.

#### Scenario: Host that can self-spawn is not forked by OCR

- **GIVEN** a review enters Phase 4 on a host whose adapter reports `supportsSubagentSpawn = true`
- **WHEN** the dashboard's `command-runner.ts` orchestrates the review
- **THEN** it SHALL NOT fork one adapter process per reviewer instance
- **AND** the host AI CLI SHALL spawn sub-agents using its own per-task primitive

#### Scenario: Host without a sub-agent primitive is fanned out by OCR

- **GIVEN** a review enters Phase 4 on a host whose adapter reports `supportsSubagentSpawn = false`
- **WHEN** the command-runner orchestrates Phase 4
- **THEN** it MAY spawn one child CLI per resolved reviewer instance via `adapter.spawnReviewer`
- **AND** each child SHALL receive that instance's resolved `--model`
- **AND** each child SHALL be journaled via the `ocr session` command family exactly as a host-spawned sub-agent would be

#### Scenario: Per-persona models honored on no-per-task-model hosts

- **GIVEN** a `default_team` assigns different models to instances on a host with `supportsPerTaskModel = false` but `supportsSubagentSpawn = false`
- **WHEN** the command-runner fans out one child CLI per reviewer
- **THEN** each child SHALL run on its own resolved model via `--model`, honoring per-persona model selection without a host per-task primitive
