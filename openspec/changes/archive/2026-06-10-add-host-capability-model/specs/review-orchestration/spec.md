## ADDED Requirements

### Requirement: Reviewers Run on Hosts Without a Sub-Agent Primitive

Phase 4 SHALL be expressed host-neutrally so that a review runs on any supported AI CLI. When the host CLI can spawn sub-agents (e.g. Claude Code's Task tool, OpenCode's sub-agent primitive), reviewers MAY be spawned in parallel. When the host CLI has no sub-agent primitive (e.g. Gemini CLI, Codex), the orchestrator SHALL run each reviewer sequentially as a fresh analytical pass within its own conversation. Both strategies SHALL journal each instance identically via the `ocr session` command family, so downstream consumers cannot distinguish them. The skill instructions SHALL NOT assume a Claude-style Task tool exists.

#### Scenario: Host with a sub-agent primitive

- **GIVEN** a host CLI that can spawn sub-agents
- **WHEN** Phase 4 runs
- **THEN** the orchestrator MAY spawn one sub-agent per resolved reviewer instance in parallel

#### Scenario: Host without a sub-agent primitive

- **GIVEN** a host CLI with no Task/sub-agent primitive (e.g. Gemini CLI, Codex)
- **WHEN** Phase 4 runs
- **THEN** the orchestrator SHALL run each resolved reviewer instance sequentially as a fresh pass in the same conversation
- **AND** each instance SHALL be journaled via `ocr session start-instance` / `bind-vendor-id` / `beat` / `end-instance` exactly as a spawned reviewer would be

#### Scenario: Sequential reviewers do not fork OCR processes

- **WHEN** reviewers run sequentially on a host without a sub-agent primitive
- **THEN** OCR SHALL NOT fork one adapter process per reviewer (consistent with "OCR Does Not Own Phase 4 Process Spawning")
- **AND** the reviewers run within the host AI CLI's own process
