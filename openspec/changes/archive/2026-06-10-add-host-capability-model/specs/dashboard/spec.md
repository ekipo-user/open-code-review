## ADDED Requirements

### Requirement: Adapter Declares Sub-Agent Spawn Capability

Each AI CLI adapter SHALL declare a `supportsSubagentSpawn` capability indicating whether the host CLI can spawn isolated reviewer sub-agents from within its own agent runtime. This is orthogonal to `supportsPerTaskModel`: a host MAY support spawning sub-agents while not supporting per-task model overrides. The capability lets the dashboard-orchestrated path select a Phase-4 strategy programmatically.

#### Scenario: Claude Code declares sub-agent spawn support

- **GIVEN** the Claude Code adapter
- **WHEN** its capabilities are read
- **THEN** `supportsSubagentSpawn` SHALL be `true`

#### Scenario: Capability is independent of per-task model support

- **GIVEN** an adapter that can spawn sub-agents but cannot vary model per sub-agent
- **WHEN** its capabilities are read
- **THEN** `supportsSubagentSpawn` SHALL be `true` and `supportsPerTaskModel` SHALL be `false`
