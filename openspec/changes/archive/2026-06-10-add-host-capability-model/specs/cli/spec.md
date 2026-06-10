## ADDED Requirements

### Requirement: Host Capability Query Command

The CLI SHALL provide `ocr host capabilities` so the review skill can determine, at runtime, how to run Phase 4 on its host. The command SHALL report, per tool, whether the host can spawn sub-agents (`subagentSpawn`) and vary the model per task (`perTaskModel`), plus the implied Phase-4 strategy. A host that does not declare capabilities SHALL resolve to the conservative default (no sub-agent spawn, no per-task model), so the skill never assumes a Claude-style Task tool exists.

#### Scenario: Query a single host as JSON

- **WHEN** a user or the skill runs `ocr host capabilities --tool gemini --json`
- **THEN** the output SHALL be a JSON object including `subagentSpawn: false`, `perTaskModel: false`, and `phase4: "sequential"`

#### Scenario: Capable host reports parallel strategy

- **WHEN** `ocr host capabilities --tool claude --json` is run
- **THEN** the output SHALL include `subagentSpawn: true` and `phase4: "parallel-subagents"`

#### Scenario: Every supported tool resolves to a complete descriptor

- **WHEN** `ocr host capabilities --json` is run with no `--tool`
- **THEN** every supported tool SHALL appear with boolean `subagentSpawn` and `perTaskModel` values — no host is omitted or left undefined

#### Scenario: Unknown tool id is rejected

- **WHEN** `ocr host capabilities --tool nonsense` is run
- **THEN** the command SHALL exit non-zero with an error listing the valid tool ids
