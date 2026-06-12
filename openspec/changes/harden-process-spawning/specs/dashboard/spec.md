# Dashboard Spec Delta — harden-process-spawning

## MODIFIED Requirements

### Requirement: AI CLI Adapter Strategy

The dashboard server SHALL use a strategy pattern to detect, select, and interact with AI CLI tools (Claude Code, OpenCode) for spawning AI operations.

#### Scenario: Adapter detection on startup

- **GIVEN** the dashboard server is starting
- **WHEN** initialization completes
- **THEN** the server SHALL check for `claude` and `opencode` binaries in PATH
- **AND** the server SHALL select the first available binary as the active adapter
- **AND** the active adapter name SHALL be exposed via the `/api/config` endpoint

#### Scenario: Adapter unavailable

- **GIVEN** no AI CLI binary (`claude` or `opencode`) is found in PATH
- **WHEN** the server attempts to initialize the AI CLI adapter
- **THEN** `aiCli.active` SHALL be `null`
- **AND** all AI-dependent features (chat, translate, address) SHALL emit descriptive error events when invoked
- **AND** the error events SHALL indicate that no AI CLI was detected

#### Scenario: Adapter spawning

- **GIVEN** an active adapter has been detected
- **WHEN** the server needs to spawn an AI operation
- **THEN** the adapter SHALL spawn its CLI with `--output-format stream-json --max-turns N` flags
- **AND** the adapter SHALL return a `ChildProcess` handle and a `parseLine()` method
- **AND** `parseLine()` SHALL normalize raw CLI output into the standard event union

#### Scenario: Prompt delivery via stdin, never argv

- **GIVEN** an adapter spawns its CLI with a prompt (workflow, chat, or query mode)
- **WHEN** the child process is created
- **THEN** the prompt SHALL be delivered on the child's stdin — it SHALL NOT appear in any argv element
- **AND** the stdin stream SHALL have an error handler attached before writing, so a child that dies before draining (EPIPE) cannot crash the dashboard process
- **AND** an empty prompt SHALL be rejected before spawning
- **AND** each adapter's spawn shape (argv plus stdin delivery) SHALL be pinned by unit tests, including the negative invariant that no argv element contains the prompt

#### Scenario: Normalized event stream

- **GIVEN** an adapter has spawned a CLI process
- **WHEN** the CLI emits raw output lines
- **THEN** the adapter's `parseLine()` SHALL parse each line into one of the normalized event types: `text`, `thinking`, `tool_start`, `tool_end`, `full_text`, `session_id`, `error`
- **AND** unrecognized lines SHALL be silently discarded

#### Scenario: Client capability detection

- **GIVEN** the dashboard client is loading
- **WHEN** the client fetches `GET /api/config`
- **THEN** the response SHALL include `aiCli.active` indicating the detected adapter name or `null`
- **AND** the client SHALL render capability-aware UI based on this value (e.g., AddressFeedbackPopover shows run mode when active, copy mode when null)
