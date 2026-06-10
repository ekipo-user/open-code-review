## ADDED Requirements

### Requirement: Adapter Spawns Isolated Reviewer Children

An AI CLI adapter SHALL provide `spawnReviewer(opts)` to spawn a single reviewer as an isolated child process, distinct from the orchestrator `spawn(opts)`. The reviewer child SHALL carry its own prompt (assembled from the reviewer-task template), its own resolved `--model`, and a read-leaning tool set, and SHALL return the same `SpawnResult` contract so the existing stream-parse and journaling pipeline is reused. This is used by the command-runner only for hosts that cannot self-spawn (`supportsSubagentSpawn = false`).

#### Scenario: Reviewer child carries its own model

- **GIVEN** the command-runner fans out reviewers on a `supportsSubagentSpawn = false` host
- **WHEN** it calls `adapter.spawnReviewer` for an instance with a resolved model
- **THEN** the spawned child process SHALL receive that model via `--model`
- **AND** the child's output SHALL be parsed by the same `parseLine` pipeline as orchestrator output

#### Scenario: Bounded concurrency

- **GIVEN** more reviewer instances than the configured concurrency limit
- **WHEN** the command-runner fans out reviewer children
- **THEN** it SHALL bound concurrent child processes with the existing pool rather than spawning all at once
