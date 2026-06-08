## MODIFIED Requirements

### Requirement: CLI Command Execution

The dashboard SHALL allow users to execute OCR CLI commands from the browser with real-time output streaming via Socket.IO, SHALL derive a command's reported outcome from the workflow's completeness rather than the process exit code alone, and SHALL mutate workflow lifecycle only by invoking the `ocr state` CLI (never by writing lifecycle tables directly).

#### Scenario: Run a CLI command

- **WHEN** user selects a command or clicks an action button
- **THEN** the client emits a `command:run` Socket.IO event
- **AND** the server spawns the CLI process and streams stdout/stderr via `command:output` events
- **AND** the terminal output is rendered with monospace font and ANSI color support

#### Scenario: Command completes with a derived outcome

- **WHEN** the spawned CLI process exits
- **THEN** the server emits a `command:finished` event carrying both the exit code and a derived `outcome`
- **AND** the `outcome` SHALL be computed from the `session_completeness` view for the linked workflow, not from `exit_code === 0` alone
- **AND** a process that exits 0 while its workflow is not genuinely complete SHALL report `incomplete`, not `success`

#### Scenario: Lifecycle mutation is delegated to the CLI

- **WHEN** a dashboard action needs to change workflow lifecycle (begin, advance, complete, finish)
- **THEN** the dashboard SHALL invoke the corresponding `ocr state` command as a child process
- **AND** the dashboard SHALL NOT write `sessions` or `orchestration_events` directly
- **AND** the dashboard SHALL write directly only to its owned tables (process-supervision journal and UX state)

#### Scenario: Available commands

- **WHEN** user opens the command palette
- **THEN** at least `ocr init`, `ocr update`, `ocr state sync`, `ocr state status` are available
- **AND** commands that mutate state require a confirmation step

#### Scenario: Concurrent command guard

- **GIVEN** a command is already running
- **WHEN** user attempts to start another command
- **THEN** a warning is shown and the user may wait or cancel the running command
