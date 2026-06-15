# cli Specification

## Purpose
The CLI package provides the primary user-facing interface for installing, configuring, and managing Open Code Review across AI coding environments. It handles initialization, dependency checking, asset management, session progress tracking, state management, and serves the interactive dashboard.
## Requirements
### Requirement: CLI Package Distribution

The CLI SHALL be distributed as an npm package (`@open-code-review/cli`) that can be executed via `npx`, `pnpm dlx`, or global installation.

#### Scenario: Execute via npx

- **GIVEN** the package is published to npm
- **WHEN** user runs `npx @open-code-review/cli --help`
- **THEN** the CLI help message is displayed

#### Scenario: Execute via global install

- **GIVEN** user runs `npm install -g @open-code-review/cli`
- **WHEN** user runs `ocr --help`
- **THEN** the CLI help message is displayed

#### Scenario: Execute via pnpm dlx

- **GIVEN** the package is published to npm
- **WHEN** user runs `pnpm dlx @open-code-review/cli init`
- **THEN** the init command executes

---

### Requirement: Init Command

The CLI SHALL provide an `init` command that configures OCR for one or more AI coding environments.

#### Scenario: Interactive tool selection

- **GIVEN** user runs `ocr init` in a TTY terminal
- **WHEN** the prompt appears
- **THEN** user can select multiple AI tools via checkbox interface
- **AND** previously configured tools are pre-selected

#### Scenario: Non-interactive with tools flag

- **GIVEN** user runs `ocr init --tools claude,cursor`
- **WHEN** the command executes
- **THEN** OCR is installed for Claude Code and Cursor only

#### Scenario: Install all tools

- **GIVEN** user runs `ocr init --tools all`
- **WHEN** the command executes
- **THEN** OCR is installed for all supported AI tools

#### Scenario: Symlink mode inside OCR repository

- **GIVEN** user runs `ocr init` from within the OCR repository
- **WHEN** installation completes
- **THEN** skill and command directories are symlinked (not copied)
- **AND** changes to source files are reflected immediately

#### Scenario: Copy mode outside OCR repository

- **GIVEN** user runs `ocr init` from an external project
- **WHEN** installation completes
- **THEN** skill and command files are copied to the target directories

#### Scenario: Session directory creation

- **GIVEN** user runs `ocr init`
- **WHEN** installation completes
- **THEN** `.ocr/sessions/` directory is created
- **AND** `.ocr/.gitignore` is created with session exclusions

---

### Requirement: Supported AI Tools

The CLI SHALL support the following AI coding environments for initialization:

| Tool | Skills Directory |
|------|------------------|
| Amazon Q Developer | `.aws/amazonq` |
| Augment (Auggie) | `.augment` |
| Claude Code | `.claude` |
| Cline | `.cline` |
| Codex | `.codex` |
| Continue | `.continue` |
| Cursor | `.cursor` |
| Gemini CLI | `.gemini` |
| GitHub Copilot | `.github` |
| Kilo Code | `.kilocode` |
| OpenCode | `.opencode` |
| Qoder | `.qoder` |
| RooCode | `.roo` |
| Windsurf | `.windsurf` |

#### Scenario: List available tools

- **GIVEN** user runs `ocr init --help`
- **WHEN** help is displayed
- **THEN** all supported tool IDs are listed in the `--tools` option description

---

### Requirement: Progress Command

The CLI SHALL provide a `progress` command that displays real-time code review progress by watching session files.

#### Scenario: Display active review progress

- **GIVEN** a code review is in progress with session files in `.ocr/sessions/`
- **WHEN** user runs `ocr progress`
- **THEN** a live-updating display shows:
  - All 8 workflow phases with completion indicators
  - Progress bar with percentage
  - Status of each reviewer (pending, in-progress, complete)
  - Elapsed time
  - Finding counts per reviewer

#### Scenario: Auto-detect current session

- **GIVEN** multiple sessions exist in `.ocr/sessions/`
- **WHEN** user runs `ocr progress`
- **THEN** the most recent active session is displayed

#### Scenario: Specify session explicitly

- **GIVEN** user runs `ocr progress --session 2025-01-26-feature-auth`
- **WHEN** the command executes
- **THEN** progress for the specified session is displayed

#### Scenario: No active session

- **GIVEN** no session files exist in `.ocr/sessions/`
- **WHEN** user runs `ocr progress`
- **THEN** message "No active review session found" is displayed

#### Scenario: Review completion

- **GIVEN** a review session completes (final.md is created)
- **WHEN** the progress display updates
- **THEN** "Review Complete" status is shown
- **AND** summary of total findings is displayed

---

### Requirement: Progress Phase Tracking

The CLI SHALL track all 8 review phases by reading from SQLite (primary) with `state.json` fallback, from the session directory.

#### Scenario: SQLite primary source

- **GIVEN** a session exists in SQLite (`sessions` table)
- **WHEN** progress command reads the session
- **THEN** it SHALL read phase information from the `sessions` table in `.ocr/data/ocr.db`
- **AND** orchestration events from `orchestration_events` for timeline data

#### Scenario: State.json fallback

- **GIVEN** a session directory exists but no corresponding row in SQLite
- **WHEN** progress command reads the session
- **THEN** it SHALL fall back to reading `state.json` for phase information
- **AND** if `state.json` is also missing, the session is treated as "waiting"

#### Scenario: State file format (SQLite)

- **GIVEN** a session row exists in SQLite
- **WHEN** progress command reads it
- **THEN** it SHALL parse:
  - `current_phase` - The current workflow phase
  - `phase_number` - Numeric phase (1-8)
  - `current_round` - Current round number
  - `started_at` - Session start timestamp
  - `updated_at` - Last update timestamp

#### Scenario: Phase completion derived from state

- **GIVEN** progress command displays phase checkmarks
- **WHEN** determining which phases are complete
- **THEN** it SHALL derive completion from `phase_number` (phases < current are complete)
- **AND** it SHALL NOT count files or use hardcoded thresholds

#### Scenario: Phase transitions

- **GIVEN** progress command is running
- **WHEN** SQLite is updated with a new phase (or `state.json` as fallback)
- **THEN** display updates to show the new current phase
- **AND** completed phases show checkmarks

#### Scenario: Waiting state

- **GIVEN** user runs `ocr progress` with no active session in SQLite or `state.json`
- **WHEN** the display renders
- **THEN** a "Waiting for review" state is shown
- **AND** the command continues watching for new sessions

#### Scenario: Cross-mode compatibility

- **GIVEN** OCR is running as a Claude Code plugin (not CLI installed)
- **WHEN** the agent writes state via `ocr state` commands (which write to SQLite)
- **THEN** `npx @open-code-review/cli progress` SHALL track the session correctly

### Requirement: Error Handling

The CLI SHALL provide clear error messages for common failure scenarios.

#### Scenario: OCR source not found

- **GIVEN** user runs `ocr init` but OCR source files cannot be located
- **WHEN** the command fails
- **THEN** error message explains how to install OCR properly

#### Scenario: Invalid tool ID

- **GIVEN** user runs `ocr init --tools invalid-tool`
- **WHEN** the command executes
- **THEN** error message lists valid tool IDs

#### Scenario: Permission denied

- **GIVEN** user lacks write permission to target directory
- **WHEN** installation fails
- **THEN** error message indicates permission issue and affected path

---

### Requirement: Agents Package Dependency

The CLI SHALL depend on the `@open-code-review/agents` package for skill files, commands, and reviewer personas.

#### Scenario: Install from agents package

- **GIVEN** user runs `ocr init`
- **WHEN** installing OCR skills and commands
- **THEN** files are sourced from the `@open-code-review/agents` package
- **AND** files are copied to `.ocr/` in the target project

#### Scenario: Package version alignment

- **GIVEN** `@open-code-review/cli` version 1.2.0 is installed
- **WHEN** checking `@open-code-review/agents` dependency
- **THEN** the agents package version matches the CLI version

---

### Requirement: Update Command

The CLI SHALL provide an `update` command that refreshes OCR assets when the package is upgraded, without requiring full re-initialization.

#### Scenario: Update all assets

- **GIVEN** user has OCR installed and upgrades `@open-code-review/cli`
- **WHEN** user runs `ocr update`
- **THEN** OCR commands/workflows are updated for all configured tools
- **AND** AGENTS.md/CLAUDE.md managed blocks are refreshed
- **AND** .ocr/skills/ is updated with latest skill files

#### Scenario: Update specific components

- **GIVEN** user runs `ocr update --commands`
- **WHEN** the command executes
- **THEN** only commands/workflows are updated
- **AND** AGENTS.md injection is skipped

#### Scenario: Update only skills and assets

- **GIVEN** user runs `ocr update --skills`
- **WHEN** the command executes
- **THEN** .ocr/skills/ is updated including:
  - SKILL.md (main skill)
  - references/ (workflow, discourse)
  - assets/reviewer-template.md
  - assets/standards/README.md
- **AND** the following are preserved (not modified):
  - .ocr/config.yaml
  - .ocr/skills/references/reviewers/ (all reviewer personas)
- **AND** AGENTS.md injection is skipped

#### Scenario: Update only AGENTS.md injection

- **GIVEN** user runs `ocr update --inject`
- **WHEN** the command executes
- **THEN** only AGENTS.md and CLAUDE.md managed blocks are refreshed
- **AND** commands/skills are not modified

#### Scenario: Detect configured tools

- **GIVEN** user previously ran `ocr init` for Claude Code and Windsurf
- **WHEN** user runs `ocr update`
- **THEN** only Claude Code and Windsurf assets are updated
- **AND** unconfigured tools are not affected

#### Scenario: No OCR installation found

- **GIVEN** user runs `ocr update` in a project without `.ocr/` directory
- **WHEN** the command executes
- **THEN** error message instructs user to run `ocr init` first

#### Scenario: Show what would be updated

- **GIVEN** user runs `ocr update --dry-run`
- **WHEN** the command executes
- **THEN** list of files that would be updated is displayed
- **AND** list of preserved files is displayed
- **AND** no files are actually modified

---

### Requirement: Reviewer Preservation During Update

The CLI SHALL preserve all reviewer persona files during updates to support future template-based reviewer management.

#### Scenario: Default reviewers preserved

- **GIVEN** user has existing reviewers in `.ocr/skills/references/reviewers/`
- **WHEN** user runs `ocr update`
- **THEN** all existing reviewer files are preserved unchanged
- **AND** no reviewer files are overwritten with package defaults

#### Scenario: Custom reviewers preserved

- **GIVEN** user has created custom reviewers (e.g., `performance.md`)
- **WHEN** user runs `ocr update`
- **THEN** custom reviewer files are preserved
- **AND** custom reviewers remain usable in reviews

#### Scenario: Fresh install includes default reviewers

- **GIVEN** user runs `ocr init` in a project without `.ocr/`
- **WHEN** installation completes
- **THEN** default reviewers are installed from the agents package
- **AND** reviewers include: principal.md, quality.md, security.md, testing.md

---

### Requirement: OCR Setup Validation

The CLI SHALL validate OCR setup before running commands that require it.

#### Scenario: Progress command without setup

- **GIVEN** user runs `ocr progress` in a project without `.ocr/` directory
- **WHEN** the command executes
- **THEN** error message explains OCR is not set up
- **AND** instructions to run `ocr init` are provided

#### Scenario: Update command without setup

- **GIVEN** user runs `ocr update` in a project without `.ocr/` directory  
- **WHEN** the command executes
- **THEN** error message explains OCR is not set up
- **AND** instructions to run `ocr init` are provided

---

### Requirement: Tool-Specific Command Installation

The CLI SHALL install commands using the appropriate naming convention for each AI tool.

#### Scenario: Subdirectory convention (Claude Code, Cursor, etc.)

- **GIVEN** user runs `ocr init --tools claude`
- **WHEN** installation completes
- **THEN** commands are installed to `.claude/commands/ocr/`
- **AND** command files are named without prefix (e.g., `doctor.md`)
- **AND** slash command format is `/ocr:doctor`

#### Scenario: Flat-prefixed convention (Windsurf)

- **GIVEN** user runs `ocr init --tools windsurf`
- **WHEN** installation completes
- **THEN** commands are installed directly to `.windsurf/workflows/`
- **AND** command files are prefixed (e.g., `ocr-doctor.md`)
- **AND** slash command format is `/ocr-doctor`

---

### Requirement: Agent-Side Setup Guard

The agents package SHALL include a setup guard sub-skill that AI assistants call before any OCR operation.

#### Scenario: Setup guard validates OCR installation

- **GIVEN** an AI assistant attempts to run an OCR command
- **WHEN** the assistant reads `references/setup-guard.md`
- **THEN** instructions guide the assistant to check for `.ocr/` directory
- **AND** instructions guide the assistant to check for `.ocr/skills/` directory

#### Scenario: Setup guard provides helpful error

- **GIVEN** OCR is not set up in the project
- **WHEN** the setup guard check fails
- **THEN** error message explains OCR is not installed
- **AND** instructions to run `ocr init` are provided
- **AND** the assistant is instructed to STOP the operation

#### Scenario: Setup guard bootstraps sessions directory

- **GIVEN** `.ocr/` exists but `.ocr/sessions/` does not
- **WHEN** the setup guard runs
- **THEN** `.ocr/sessions/` is created automatically

---

### Requirement: Project Standards Template

The CLI SHALL install a customizable project standards template that users can edit to provide review context.

#### Scenario: Standards template installed

- **GIVEN** user runs `ocr init`
- **WHEN** installation completes
- **THEN** `.ocr/skills/assets/standards/README.md` is created
- **AND** the file is a fillable template with commented placeholders

#### Scenario: Standards template content

- **GIVEN** the standards template is installed
- **WHEN** user opens `.ocr/skills/assets/standards/README.md`
- **THEN** sections for Repository Standards References exist
- **AND** sections for Key Requirements exist
- **AND** sections for Constraints exist
- **AND** sections for Review Focus Areas exist

#### Scenario: Standards included in reviews

- **GIVEN** user has customized the standards template
- **WHEN** a code review runs
- **THEN** the standards content is included in reviewer context

---

### Requirement: Claude Code Plugin Distribution

The agents package SHALL be structured as a valid Claude Code plugin for native installation in Claude Code.

#### Scenario: Plugin manifest present

- **GIVEN** the agents package at `packages/agents/`
- **WHEN** checking for plugin compatibility
- **THEN** `.claude-plugin/plugin.json` manifest exists
- **AND** manifest contains required fields (name, description, version)

#### Scenario: Plugin directory structure

- **GIVEN** the agents package is structured as a plugin
- **WHEN** installed via `claude --plugin-dir`
- **THEN** `commands/` contains slash command definitions
- **AND** `skills/ocr/` contains the main OCR skill
- **AND** commands are accessible as `/open-code-review:command`

#### Scenario: Plugin installation via marketplace

- **GIVEN** user adds the OCR marketplace in Claude Code
- **WHEN** user runs `/plugin install open-code-review`
- **THEN** OCR skills and commands are available from plugin cache
- **AND** commands are namespaced as `/open-code-review:review`
- **AND** `.ocr/sessions/` is created JIT by setup-guard when first command runs

#### Scenario: CLI compatibility maintained

- **GIVEN** the plugin directory structure (`skills/ocr/`)
- **WHEN** user runs `ocr init` via CLI
- **THEN** skills are installed from `skills/ocr/` to `.ocr/skills/`
- **AND** commands are installed to tool-specific directories
- **AND** both CLI and plugin installations work independently

### Requirement: Doctor Command

The CLI SHALL provide a `doctor` command that checks external dependencies and OCR installation status, providing actionable remediation for any issues found.

#### Scenario: All checks pass

- **GIVEN** `git`, `claude`, and `gh` are in PATH and OCR is initialized
- **WHEN** user runs `ocr doctor`
- **THEN** a compact status block shows green checkmarks with version numbers for all dependencies
- **AND** OCR installation checks show `.ocr/skills/`, `.ocr/sessions/`, `.ocr/config.yaml`, `.ocr/data/ocr.db`
- **AND** "Ready for code review!" summary is displayed
- **AND** the process exits with code 0

#### Scenario: Required dependency missing

- **GIVEN** `claude` is not in PATH
- **WHEN** user runs `ocr doctor`
- **THEN** the preflight block shows a red `✗` next to "Claude Code" with "not found"
- **AND** the summary shows "Issues found" with an install URL
- **AND** the process exits with code 1

#### Scenario: Optional dependency missing

- **GIVEN** `gh` (GitHub CLI) is not in PATH but all required deps are present
- **WHEN** user runs `ocr doctor`
- **THEN** the preflight block shows a dim `✗` next to "GitHub CLI" with "not found (optional)"
- **AND** the summary shows "Ready for code review!" (optional deps do not cause failure)
- **AND** the process exits with code 0

#### Scenario: OCR not initialized

- **GIVEN** `.ocr/` directory does not exist
- **WHEN** user runs `ocr doctor`
- **THEN** OCR installation checks show dim `✗` for all OCR paths
- **AND** the summary shows "Issues found" with instruction to run `ocr init`
- **AND** the process exits with code 1

#### Scenario: Informational OCR checks

- **GIVEN** `.ocr/data/ocr.db` does not exist (no review run yet)
- **WHEN** user runs `ocr doctor`
- **THEN** the database check shows dim `✗` with "(created on first review)" hint
- **AND** this does NOT cause exit code 1 (informational only)

---

### Requirement: Init Preflight Check

The `ocr init` command SHALL display a dependency check block after the banner and before tool selection, without blocking initialization.

#### Scenario: All dependencies found

- **GIVEN** `git`, `claude`, and `gh` are in PATH
- **WHEN** user runs `ocr init`
- **THEN** a "Preflight" block shows green checkmarks with versions for all dependencies
- **AND** tool selection proceeds normally

#### Scenario: Required dependency missing during init

- **GIVEN** `claude` is not in PATH
- **WHEN** user runs `ocr init`
- **THEN** the preflight block shows a red `✗` for Claude Code with "not found"
- **AND** a yellow warning with install URL is displayed
- **AND** initialization continues (non-blocking)
- **AND** tool selection proceeds normally

---

### Requirement: Dependency Check Module

The CLI SHALL provide a shared internal module for checking external binary dependencies, used by both `init` and `doctor` commands.

#### Scenario: Check binary availability

- **GIVEN** a list of dependencies to check (git, claude, gh)
- **WHEN** `checkDependencies()` is called
- **THEN** each binary is tested via `execFileSync(binary, ['--version'])` with a 5-second timeout
- **AND** the version is parsed from stdout using a semver-like regex
- **AND** the result includes `found`, `version`, `required`, and `installHint` for each dependency

#### Scenario: Print dependency status

- **GIVEN** a `DepCheckResult` from `checkDependencies()`
- **WHEN** `printDepChecks()` is called
- **THEN** a column-aligned block is printed with checkmarks/X marks and versions
- **AND** missing required deps show red `✗` with warnings (unless `suppressWarnings` is true)
- **AND** missing optional deps show dim `✗` with "(optional)" suffix

### Requirement: Dashboard Command

The CLI SHALL provide a `dashboard` command that starts a local HTTP + WebSocket server and opens the dashboard in the user's default browser.

#### Scenario: Start dashboard

- **GIVEN** user has run `ocr init` (`.ocr/` directory exists)
- **WHEN** user runs `ocr dashboard`
- **THEN** a local server starts on port 4173 (default) serving both HTTP and Socket.IO
- **AND** the user's default browser opens to `http://localhost:4173`
- **AND** the terminal displays the URL, Socket.IO status, and "Press Ctrl+C to stop"

#### Scenario: Custom port

- **GIVEN** port 4173 is in use
- **WHEN** user runs `ocr dashboard --port 8080`
- **THEN** server starts on port 8080

#### Scenario: No browser auto-open

- **WHEN** user runs `ocr dashboard --no-open`
- **THEN** server starts but browser does not open

#### Scenario: No OCR setup

- **GIVEN** `.ocr/` directory does not exist
- **WHEN** user runs `ocr dashboard`
- **THEN** the command exits with an error: "OCR not initialized. Run `ocr init` first."

#### Scenario: Database auto-creation

- **GIVEN** `.ocr/` exists but `.ocr/data/ocr.db` does not
- **WHEN** user runs `ocr dashboard`
- **THEN** the database is created, migrations run, and the server starts normally

---

### Requirement: Zero Dashboard Startup Cost

The dashboard code SHALL NOT be loaded unless the user runs `ocr dashboard`. Commands like `ocr init`, `ocr progress`, and `ocr state` MUST remain fast.

#### Scenario: Dynamic import only on dashboard command

- **GIVEN** user runs any CLI command other than `ocr dashboard`
- **WHEN** the CLI process starts
- **THEN** the dashboard server module (`dist/dashboard/server.js`) SHALL NOT be imported or loaded

#### Scenario: Dashboard dependencies isolated

- **GIVEN** the dashboard pulls in heavy client dependencies (such as its UI framework, real-time transport, and any diagramming library)
- **WHEN** user runs `ocr init` or `ocr progress`
- **THEN** none of these dependencies are loaded
- **AND** CLI startup time is unaffected

### Requirement: OCR State Map-Complete Command

The `ocr state map-complete` CLI subcommand SHALL accept structured map data, validate it, optionally write `map-meta.json`, and record a `map_completed` orchestration event. This command is parallel to `round-complete` for map workflows.

#### Scenario: Stdin mode (recommended)

- **GIVEN** a map run has completed
- **WHEN** the orchestrator pipes structured JSON to `ocr state map-complete --stdin`
- **THEN** the CLI SHALL:
  - Parse and validate the JSON against the `MapMeta` schema (`schema_version`, `sections` array with files, optional `dependencies` array)
  - Derive section and file counts from the sections array
  - Write `map-meta.json` to the correct session map run directory (`{session_dir}/map/runs/run-{n}/map-meta.json`)
  - Insert a `map_completed` event into `orchestration_events` with metadata containing derived counts and `source: "orchestrator"`
  - Return the session ID, map run number, and written file path

#### Scenario: File mode

- **GIVEN** a `map-meta.json` file already exists on disk
- **WHEN** the user runs `ocr state map-complete --file <path>`
- **THEN** the CLI SHALL read and validate the file, record the orchestration event, but NOT write the file
- **AND** the returned result SHALL have `metaPath` as undefined

#### Scenario: Auto-detect session and map run

- **GIVEN** neither `--session-id` nor `--map-run` is provided
- **WHEN** `ocr state map-complete` runs
- **THEN** the CLI SHALL auto-detect the active session and use its `current_map_run`

#### Scenario: Invalid schema

- **GIVEN** the piped JSON has invalid `schema_version` or is missing required fields
- **WHEN** `ocr state map-complete --stdin` processes the input
- **THEN** the CLI SHALL throw a validation error with a descriptive message

#### Scenario: Mutual exclusion

- **WHEN** neither `--file` nor `--stdin` is provided, or both are provided
- **THEN** the CLI SHALL exit with an error explaining that exactly one source is required

---

### Requirement: Completion Command Shared Internals

The `round-complete` and `map-complete` subcommands SHALL share common internal helpers to avoid code duplication.

#### Scenario: Shared JSON reading

- **WHEN** either completion command reads input
- **THEN** both SHALL use the same `readJsonFromSource` helper that handles file-read (with existence check) and stdin-data passthrough

#### Scenario: Shared JSON parsing

- **WHEN** either completion command parses JSON
- **THEN** both SHALL use the same `parseRawJson` helper with descriptive error labels (file path or "stdin")

#### Scenario: Shared session resolution

- **WHEN** either completion command resolves the target session
- **THEN** both SHALL use the same `resolveSessionForCompletion` helper that supports explicit `--session-id` or auto-detection of the active session

---

### Requirement: CLI Update Notifier

The CLI SHALL perform a non-blocking background check for newer versions on npm when human-facing commands run, and print a styled notification to stderr after command output completes.

#### Scenario: Update available

- **GIVEN** user runs a human-facing CLI command (`init`, `update`, `doctor`, `dashboard`, or `progress`)
- **WHEN** the npm registry reports a newer version than the installed version
- **THEN** after the command output completes, a styled notification SHALL be printed to stderr containing:
  - The current version and the latest version
  - A copy-pasteable update command: `npm i -g @open-code-review/cli@latest && ocr update`
- **AND** the notification SHALL NOT interleave with command stdout/stderr

#### Scenario: Already on latest version

- **GIVEN** the installed version matches or exceeds the latest npm version
- **WHEN** a human-facing command runs
- **THEN** no update notification SHALL be printed

#### Scenario: Human-facing command scope

- **GIVEN** the CLI is invoked
- **WHEN** the subcommand is one of: `init`, `update`, `doctor`, `dashboard`, `progress`
- **THEN** the update check SHALL fire
- **AND** when the subcommand is `state` (or any other AI-invoked command), the update check SHALL NOT fire

#### Scenario: Non-blocking execution

- **GIVEN** a human-facing command is invoked
- **WHEN** the update check fires
- **THEN** the check SHALL run as a background promise that starts before `parseAsync()` and resolves after command output
- **AND** a 500ms race timeout SHALL ensure the CLI exits promptly even if the check is slow
- **AND** `program.parse()` SHALL be replaced with `await program.parseAsync()` to properly await async action handlers

#### Scenario: Result caching

- **GIVEN** a successful registry fetch
- **WHEN** the result is obtained
- **THEN** the version SHALL be cached at `~/.ocr/update-check.json` with a timestamp
- **AND** subsequent checks within a 4-hour TTL SHALL use the cached version without fetching

#### Scenario: Cache expired

- **GIVEN** the cached result is older than 4 hours
- **WHEN** a human-facing command runs
- **THEN** a fresh fetch SHALL be made to the npm registry
- **AND** the cache SHALL be updated with the new result

#### Scenario: CI environment suppression

- **GIVEN** the `CI` environment variable is set
- **WHEN** a human-facing command runs
- **THEN** the update check SHALL be skipped entirely (no fetch, no cache read)

#### Scenario: Explicit suppression

- **GIVEN** the `OCR_NO_UPDATE_CHECK` environment variable is set
- **WHEN** a human-facing command runs
- **THEN** the update check SHALL be skipped entirely

#### Scenario: Network error resilience

- **GIVEN** the npm registry fetch fails (timeout, DNS error, network unreachable)
- **WHEN** the check runs
- **THEN** no notification SHALL be printed
- **AND** a cache entry with `latestVersion: null` SHALL be written to prevent repeated failed fetches within the TTL

#### Scenario: Fetch timeout

- **GIVEN** the registry does not respond within 3 seconds
- **WHEN** the fetch is in progress
- **THEN** the fetch SHALL be aborted via `AbortSignal.timeout(3000)`
- **AND** the check SHALL return null (no notification)

### Requirement: `ocr team` Subcommand

The CLI SHALL provide an `ocr team` subcommand for resolving and persisting team composition, used by the AI workflow and the dashboard.

#### Scenario: Resolve produces canonical reviewer instances

- **GIVEN** a workspace with `default_team` defined in `.ocr/config.yaml`
- **WHEN** user runs `ocr team resolve --json`
- **THEN** the output SHALL be a JSON array of `ReviewerInstance` objects with fields `persona`, `instance_index`, `name`, `model`
- **AND** the array SHALL reflect alias expansion and the model resolution chain

#### Scenario: Session override is applied without persisting

- **GIVEN** a workspace with `default_team: { principal: 2 }`
- **WHEN** user runs `ocr team resolve --session-override "principal=[claude-opus-4-7,claude-sonnet-4-6]" --json`
- **THEN** the resolved composition SHALL contain two `principal` instances with the overridden models
- **AND** `.ocr/config.yaml` SHALL NOT be modified

#### Scenario: Set persists a new team to config

- **GIVEN** a workspace and a JSON array of `ReviewerInstance` objects on stdin
- **WHEN** user runs `ocr team set --stdin`
- **THEN** the system SHALL validate the input, normalize it, and write it back to `.ocr/config.yaml > default_team`
- **AND** SHALL preserve user comments where the YAML library permits

---

### Requirement: `ocr models` Subcommand

The CLI SHALL provide an `ocr models list` subcommand that surfaces the model
identifiers the active vendor CLI is willing to accept, sourced from the
per-vendor model-listing strategy table in the CLI model-discovery library.
That table SHALL be the single source of truth for vendor model enumeration
across every surface (CLI command and dashboard route). Each vendor strategy
SHALL declare either a native enumeration probe (binary arguments plus an
output parser) or that native enumeration is unsupported with a
human-readable reason. Supported-vendor validation everywhere SHALL derive
from the strategy table, so adding a vendor is a single registration.

#### Scenario: Native enumeration via the vendor strategy's probe

- **GIVEN** the vendor strategy declares a native probe (e.g. OpenCode's
  `opencode models`, parsed as newline-delimited `provider/model` ids)
- **WHEN** the user runs `ocr models list` and the probe succeeds
- **THEN** the output SHALL include the vendor-native model identifiers
  returned by the underlying CLI
- **AND** the result SHALL report `source: "native"`

#### Scenario: Bundled fallback when the probe fails

- **GIVEN** the vendor strategy declares a native probe
- **WHEN** the probe fails (binary missing, non-zero exit, or unparseable
  output — including parseable output yielding zero model ids)
- **THEN** the output SHALL include the strategy's bundled known-good list
- **AND** the result SHALL report `source: "bundled"` with a
  `nativeUnavailableReason` describing the failure, including captured
  stderr where available

#### Scenario: Bundled fallback when the vendor declares no enumeration

- **GIVEN** the vendor strategy declares native enumeration unsupported
  (e.g. Claude Code, which has no model-listing command)
- **WHEN** the user runs `ocr models list`
- **THEN** no enumeration process SHALL be spawned
- **AND** the output SHALL include the strategy's bundled list with
  `source: "bundled"` and the strategy's curated `nativeUnavailableReason`
- **AND** the bundled list SHALL prefer vendor-native identifiers that do not
  go stale (e.g. Claude Code's documented `opus` / `sonnet` / `haiku`
  aliases) over dated model ids

#### Scenario: JSON output for programmatic consumption

- **GIVEN** the dashboard or workflow needs the model list
- **WHEN** `ocr models list --json` is invoked
- **THEN** the output SHALL be a single JSON envelope
  `{ vendor, source, models, nativeUnavailableReason? }` where `models` is an
  array of `{ id, displayName?, provider?, tags? }` records
- **AND** when no supported vendor is detected, the envelope SHALL be
  `{ vendor: null, source: null, models: [] }`

#### Scenario: Free-text model ids are gatekept only by the vendor-id syntax class

- **GIVEN** a user wants a model id that is not in the listed set
- **WHEN** any OCR surface accepts a model id
- **THEN** the listed models SHALL remain advisory only
- **AND** any string matching the vendor-id syntax class
  (`/^[A-Za-z0-9][A-Za-z0-9._/:@\[\]+-]{0,255}$/` — covering aliases like
  `sonnet[1m]`, dated ids, provider-prefixed and multi-slash ids, `:tag` and
  `@version` forms) SHALL be accepted and passed to the vendor CLI unchanged
- **AND** strings outside that class (whitespace, quotes, shell
  metacharacters — strings no vendor model id can be) SHALL be rejected at
  the configuration parse boundary with an error naming the offending
  character
- **AND** rejection SHALL NOT occur during model enumeration or at adapter
  spawn time

### Requirement: `ocr session` Subcommand Family

The CLI SHALL provide an `ocr session` subcommand family used by the AI to journal agent-CLI processes it spawns. None of these subcommands SHALL spawn, fork, or watch processes themselves.

#### Scenario: Start an agent session

- **GIVEN** the AI is about to spawn a reviewer sub-agent
- **WHEN** the AI runs `ocr session start-instance --workflow <id> --persona principal --instance 1 --name principal-1 --vendor claude --model claude-opus-4-7`
- **THEN** the system SHALL insert a row in `agent_sessions` with `status = 'running'`, `started_at = now`, and `last_heartbeat_at = now`
- **AND** SHALL print the new agent-session UUID on stdout

#### Scenario: Bind a vendor session id

- **GIVEN** an agent session has been started and the underlying CLI has emitted its session id
- **WHEN** the AI runs `ocr session bind-vendor-id <agent-id> <vendor-id>`
- **THEN** the row's `vendor_session_id` SHALL be set
- **AND** subsequent attempts to bind a different value SHALL be rejected

#### Scenario: Bump a heartbeat

- **GIVEN** an agent session is `running`
- **WHEN** the AI runs `ocr session beat <agent-id>`
- **THEN** the row's `last_heartbeat_at` SHALL be set to the current time

#### Scenario: End an agent session

- **GIVEN** an agent session is in progress
- **WHEN** the AI runs `ocr session end-instance <agent-id> --exit-code 0`
- **THEN** the row SHALL transition to `status = 'done'` (or `crashed`/`cancelled` based on exit-code semantics or explicit `--status`)
- **AND** `ended_at` SHALL be set

#### Scenario: List agent sessions for a workflow

- **GIVEN** a workflow with multiple agent sessions
- **WHEN** user or dashboard runs `ocr session list --workflow <id> --json`
- **THEN** the output SHALL be a JSON array of `agent_sessions` rows for that workflow

#### Scenario: Subcommands do not own processes

- **GIVEN** any of `ocr session start-instance`, `bind-vendor-id`, `beat`, `end-instance` are invoked
- **WHEN** the command executes
- **THEN** it SHALL only read from and write to the database
- **AND** SHALL NOT spawn, fork, kill, or watch any other process

---

### Requirement: Resume Flag on Existing Review Command

The CLI's `ocr review` command SHALL accept a `--resume <workflow-session-id>` flag that re-spawns the host AI CLI to continue a workflow. This flag is the **optional convenience** path used by the dashboard ("Continue here") and by a terminal handoff; the baseline forward-resume path is simply re-invoking the review skill, which needs no flag, no adapter, and no captured vendor id. When a vendor resume adapter exists for the host (Claude Code and OpenCode today) and a `vendor_session_id` was captured, `--resume` SHALL dispatch through that adapter's resume primitive to preserve conversational continuity; otherwise it SHALL spawn a fresh host turn bound to the existing OCR session so forward progress is still possible. In all cases the re-spawned turn is driven by the **canonical CONTROL prompt** (defined once in review-orchestration `Atomic Completion Contract`), never by injected review context, and the prompt is identical across hosts with all delivery differences confined to the adapter.

Resume SHALL be **forward-only and idempotent**: the continuation reads `current_phase` from `ocr state status --json` and drives forward, never regressing `current_phase` and never appending a duplicate terminal event. Resume SHALL acquire the single-writer resume lease (`Forward-Resume of a Stranded Mid-Pipeline Run`) before driving forward, and is bounded by `runtime.forward_resume_max_attempts`; when the cap is exhausted it SHALL refuse and direct the operator to `ocr state finish --abort` or a fresh review.

#### Scenario: Resume by workflow id via the vendor adapter

- **GIVEN** a workflow `sessions` row whose host has a resume adapter and at least one `agent_sessions` row whose `vendor_session_id` is set
- **WHEN** user runs `ocr review --resume <workflow-session-id>`
- **THEN** the system SHALL look up the most recent agent-session for that workflow with a non-null `vendor_session_id`
- **AND** SHALL spawn the host CLI with its vendor-native resume flag, the captured `vendor_session_id`, and the fixed CONTROL prompt

#### Scenario: Resume without a captured vendor id hands off to the baseline skill path

- **GIVEN** a workflow for which no `vendor_session_id` (and thus no resume adapter binding) was ever captured (e.g. it crashed before the first `session_id` event, or ran on a host with no resume adapter)
- **WHEN** user runs `ocr review --resume <workflow-session-id>`
- **THEN** the system SHALL hold the resume lease (so a concurrent auto-resume cannot double-drive) and direct the operator to re-invoke the review skill (`/ocr-review`), whose Phase 0 reads `ocr state status --json` and continues forward from `current_phase` with no adapter — work is preserved, continuity is not required
- **AND** it SHALL exit zero (this is the honest baseline path, not an error)

#### Scenario: Resume is forward-only and reuses prior work

- **GIVEN** a stranded run with `current_phase = reviews`
- **WHEN** resume drives the continuation
- **THEN** the continuation SHALL re-enter `reviews` and proceed forward, the workflow re-spawning only the reviewers whose outputs are absent
- **AND** it SHALL NOT regress `current_phase` or duplicate a terminal event

#### Scenario: Resume refuses once the re-spawn cap is exhausted

- **GIVEN** a stranded run whose current round already has `forward_resume_max_attempts` `forward_resume` lease events
- **WHEN** user runs `ocr review --resume <workflow-session-id>`
- **THEN** the command SHALL, in addition to refusing and exiting non-zero, drive the run to the terminal non-success close through the guarded close path (the same `session_auto_closed_stale {reason: "forward_resume_exhausted"}` close the dashboard watchdog would write) — so a no-daemon, human-only cap exhaustion never leaves the session inert-`active`
- **AND** it SHALL direct the operator to start a fresh review (the run is now closed)

### Requirement: Instruction File Injection

The CLI SHALL inject OCR instructions into project instruction files based on the selected tools, following the OpenSpec managed block pattern. The CLI SHALL always write the universal `AGENTS.md`, and additionally write each selected tool's native instruction file(s) as declared by `AIToolConfig.instructionFiles`. The CLI SHALL NOT write a tool-specific instruction file for a tool that was not selected — in particular, `CLAUDE.md` is written only when Claude Code is selected. A file shared by the selection (such as `AGENTS.md`) SHALL be written at most once.

#### Scenario: AGENTS.md is always written

- **GIVEN** user runs `ocr init` selecting any set of tools with injection enabled
- **WHEN** installation completes
- **THEN** a managed block `<!-- OCR:START -->...<!-- OCR:END -->` is appended to `AGENTS.md` (created if absent)

#### Scenario: Claude Code selected

- **GIVEN** user runs `ocr init` and Claude Code is among the selected tools
- **WHEN** installation completes
- **THEN** the managed block is also written to `CLAUDE.md`

#### Scenario: Non-Claude tool gets its native file, not CLAUDE.md

- **GIVEN** user runs `ocr init` selecting only Gemini CLI
- **WHEN** installation completes
- **THEN** the managed block is written to `GEMINI.md`
- **AND** no `CLAUDE.md` is created

#### Scenario: Tool that reads AGENTS.md natively gets no extra file

- **GIVEN** user runs `ocr init` selecting only Codex
- **WHEN** installation completes
- **THEN** only `AGENTS.md` receives the managed block and no tool-specific instruction file is created

#### Scenario: Non-markdown instruction file uses plaintext markers

- **GIVEN** user runs `ocr init` selecting Windsurf, whose native file is `.windsurfrules`
- **WHEN** installation completes
- **THEN** the managed block in `.windsurfrules` is delimited by line-comment markers (`# OCR:START` / `# OCR:END`) rather than HTML-comment markers

#### Scenario: Update existing instructions

- **GIVEN** an instruction file already contains an OCR managed block
- **WHEN** user runs `ocr init` or `ocr update` again
- **THEN** the existing managed block is replaced with the updated version
- **AND** content outside the managed block is preserved

#### Scenario: Stale instruction file is reported, not deleted

- **GIVEN** a `CLAUDE.md` contains an OCR managed block but Claude Code is no longer a configured tool
- **WHEN** user runs `ocr update`
- **THEN** the CLI warns that the file holds a stale OCR block
- **AND** the CLI does not delete or rewrite the file

#### Scenario: Skip injection with flag

- **GIVEN** user runs `ocr init --no-inject`
- **WHEN** installation completes
- **THEN** no instruction files are created or modified

### Requirement: Tool Instruction-File Mapping

The CLI SHALL maintain, as part of each tool's `AIToolConfig`, the tool's native instruction file(s) (`instructionFiles`) beyond the universal `AGENTS.md`. This mapping is the single source of truth that drives instruction injection, so that supporting a new tool is a configuration-only change. A tool that reads `AGENTS.md` natively SHALL declare no additional instruction file.

#### Scenario: Native file declared per tool

- **WHEN** the tool registry is consulted for injection
- **THEN** Claude Code maps to `CLAUDE.md`, Gemini CLI to `GEMINI.md`, GitHub Copilot to `.github/copilot-instructions.md`, and Windsurf to `.windsurfrules`
- **AND** Codex, OpenCode, and Cursor declare no additional file (they read `AGENTS.md`)

#### Scenario: Each instruction file declares its format

- **WHEN** an instruction file is a non-markdown file such as `.windsurfrules`
- **THEN** its mapping declares a `plaintext` format so the injector uses line-comment managed-block markers

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

### Requirement: Atomic State Lifecycle Commands

The CLI SHALL provide a semantic, atomic porcelain for workflow lifecycle so that orchestrating agents make correct state updates by default and cannot leave a round partially completed. Each command SHALL perform all of its mutations within a single database transaction. A successful `complete-round` SHALL be a complete result on **both** sides of the boundary — the database transition **and** a validated `round-meta.json` materialized at the canonical round path — regardless of whether the payload arrived via `--stdin` or `--file`, so the database can never report a round `complete` while its on-disk artifact is absent.

`ocr state status --json` SHALL expose a typed, closed `next_action` enum (per `Stranded-Run Next-Action Derivation`) so an orchestrator or watchdog can act on it without parsing prose or inspecting the filesystem. When a session is stranded mid-pipeline (incomplete and its owning turn ended), the status SHALL also report `current_phase`, the ordered `remaining_phases`, and the remaining forward-resume attempts.

#### Scenario: Begin starts or resumes a workflow

- **WHEN** an agent runs `ocr state begin --workflow-type review`
- **THEN** the command SHALL create or resume the session and emit JSON `{session_id, round, phase, completeness}`
- **AND** session resolution SHALL follow `--session-id` → `OCR_DASHBOARD_EXECUTION_UID` → single active session, refusing when more than one active session exists and none is specified

#### Scenario: Begin refuses to re-open an active, incomplete session

- **WHEN** `ocr state begin` would re-open a session that is already `active` and whose current round has no `round_completed` event (a stranded mid-pipeline run)
- **THEN** the command SHALL NOT reset `current_phase` to the workflow's initial phase and SHALL NOT emit a new-round `session_resumed`
- **AND** it SHALL direct the operator to forward-resume instead (the `begin` re-open path is reserved for starting the *next* round on a completed session), so a stranded run can never be silently regressed to `context`

#### Scenario: Advance validates the phase graph and derives the phase number

- **WHEN** an agent runs `ocr state advance --phase reviews`
- **THEN** the command SHALL reject the transition if it is not a legal edge for the session's workflow type
- **AND** the phase number SHALL be derived from the phase name (no separate `--phase-number` argument is required)

#### Scenario: Complete-round is atomic and invariant-checked

- **WHEN** an agent supplies round metadata to `ocr state complete-round` via either `--stdin` or `--file`
- **THEN** the command SHALL, in one transaction, validate the metadata, assert the session has reached `synthesis`, write `round-meta.json` to the canonical round path, append a `round_completed` event, advance `current_round`, and transition the phase to `complete`
- **AND** if any precondition fails, the command SHALL make no changes and exit with the invariant-unmet code
- **AND** on success a validated `round-meta.json` SHALL exist at `rounds/round-N/round-meta.json` irrespective of the input source (when the source already is that canonical file, the write is a validated identity no-op)

#### Scenario: Complete-round never leaves the database ahead of the artifact

- **WHEN** `complete-round` completes successfully for a round
- **THEN** the canonical `round-meta.json` for that round SHALL be present on disk
- **AND** there SHALL be no success path on which, **at commit time**, the `round_completed` event and phase transition are committed while the artifact is absent (the invariant binds the commit boundary; a later out-of-band `rm round-meta.json` is recovered by the self-heal path below, not a retroactive violation)

#### Scenario: Re-running complete-round is a safe no-op or self-heals the artifact

- **WHEN** an agent re-runs `complete-round` for a round that already has a `round_completed` event
- **THEN** if the canonical `round-meta.json` is present, the command SHALL be a safe no-op (no duplicate event, no re-advance)
- **AND** if the canonical `round-meta.json` is absent, the command SHALL re-materialize it **from the recorded round metadata in the `round_completed` event payload** (the source of truth) without appending a duplicate `round_completed` event or re-advancing the round

#### Scenario: Complete-map is atomic for map runs

- **WHEN** an agent pipes map metadata to `ocr state complete-map --stdin`
- **THEN** the command SHALL atomically write `map-meta.json`, append a `map_completed` event for the current map run, and transition the phase to `complete`

#### Scenario: Finish refuses to close an incomplete session

- **WHEN** an agent runs `ocr state finish`
- **AND** the current round has no `round_completed` event
- **THEN** the command SHALL refuse with the invariant-unmet code and SHALL NOT close the session

#### Scenario: Finish with abort records an explicit reason

- **WHEN** an agent runs `ocr state finish --abort`
- **THEN** the session SHALL be closed with a `session_aborted` event
- **AND** the closed session SHALL NOT be reported as a successful completion

#### Scenario: Status reports completeness and what is missing

- **WHEN** an agent runs `ocr state status --json`
- **THEN** the command SHALL return the session's `completeness_state`, per-obligation booleans, and a `next_action` value drawn from the closed enum `{none, finish, forward_resume, abort_or_fresh}` (per `Stranded-Run Next-Action Derivation`)

#### Scenario: Status reports a forward-resumable stall

- **WHEN** an agent runs `ocr state status --json` for a session stranded mid-pipeline (incomplete, owning turn ended, attempts remaining)
- **THEN** the command SHALL report `next_action = forward_resume`, the `current_phase`, the ordered `remaining_phases`, and the remaining forward-resume attempts
- **AND** when no attempts remain or there is no legal forward edge, it SHALL report `next_action = abort_or_fresh` instead

### Requirement: State Command Exit Code Taxonomy

State lifecycle commands SHALL use a stable, documented exit-code taxonomy so that an orchestrating agent can branch on the failure class without parsing prose.

#### Scenario: Distinct codes per failure class

- **WHEN** a state command fails
- **THEN** it SHALL exit with `2` for usage errors, `3` for ambiguous session resolution, `4` for session-not-found, `5` for an illegal phase transition, `6` for an unmet invariant, `7` for schema-invalid input, and `8` for database-busy past the retry budget
- **AND** it SHALL exit `0` only on success

#### Scenario: Ambiguity is a typed refusal

- **GIVEN** more than one active session exists and no `--session-id` is provided
- **WHEN** a state command resolves the session
- **THEN** it SHALL exit with code `3` and name the candidate sessions

#### Scenario: Busy is the retry signal

- **WHEN** a transaction surfaces `SQLITE_BUSY` past the bounded retry budget
- **THEN** the command SHALL exit with code `8`, signalling the orchestrator to wait briefly and retry the same call

### Requirement: Engine Distribution and Runtime Floor

The CLI SHALL install and run with a working SQLite engine under any package
manager (npm, pnpm including 10+, yarn) with **no native build step and no
install script**, and SHALL fail clearly on an unsupported runtime rather than
crashing. (The engine itself — Node's built-in `node:sqlite` — is specified
under the `sqlite-state` capability; this requirement covers distribution and
the runtime floor.)

#### Scenario: Installs with no native build under any package manager

- **WHEN** the CLI is installed with npm, pnpm (incl. 10+ with build scripts blocked), or yarn
- **THEN** no native module is compiled and no install script runs
- **AND** `ocr doctor` reports the storage engine loaded and on-disk DB commands succeed

#### Scenario: Too-old Node fails fast with a clear message

- **GIVEN** a runtime older than Node 22.5
- **WHEN** any `ocr` command runs
- **THEN** the CLI SHALL print a message stating it requires Node >= 22.5 and how to upgrade, and exit non-zero
- **AND** it SHALL NOT emit a `Cannot find module 'node:sqlite'` stack trace

#### Scenario: The experimental warning does not pollute output

- **WHEN** the engine loads
- **THEN** `node:sqlite`'s one-line experimental warning SHALL be suppressed, leaving the machine-readable stdout contract (e.g. `ocr state status --json`) untouched

#### Scenario: The published tarball is install-verified before release

- **WHEN** a release is prepared
- **THEN** CI SHALL install the **published cli tarball** under **both npm and pnpm 10 (default, scripts blocked)** on supported Node versions, asserting the engine loads (including an on-disk WAL transaction round-trip via `ocr doctor --probe-write`) and a real DB command succeeds, **before** promoting the release to the `latest` dist-tag

### Requirement: Process Spawning Safety

All OCR process spawning SHALL go through the shared platform wrappers
(`execBinary`, `execBinaryAsync`, `spawnBinary`), which SHALL pass arguments
verbatim as argv on every platform — never through an interpreting shell —
while still resolving Windows `.cmd`/`.bat` shims. Free-text content (prompts,
requirements, reviewer descriptions) SHALL NOT be required to be
shell-safe: safety is the spawn layer's job.

#### Scenario: Arguments are not shell-interpreted on Windows

- **GIVEN** an argument containing cmd.exe metacharacters (e.g.
  `sonnet & calc.exe`)
- **WHEN** it is passed to a platform spawn wrapper on Windows
- **THEN** the child process SHALL receive the argument verbatim as a single
  argv entry
- **AND** no secondary command SHALL execute

#### Scenario: Windows .cmd shims still resolve

- **GIVEN** a vendor binary installed as an npm `.cmd` shim (e.g. `claude`,
  `opencode`, `ocr`)
- **WHEN** a platform wrapper spawns it by bare name on Windows
- **THEN** the shim SHALL resolve and execute without the caller opting into
  a shell

#### Scenario: Missing binaries are reported as ENOENT on every platform

- **WHEN** a wrapper spawns a binary that is not installed
- **THEN** the failure SHALL carry `code: "ENOENT"` on Windows and POSIX
  alike (not a shell's "not recognized" exit 1)

#### Scenario: execBinaryAsync failure shape is a stable contract

- **WHEN** an async exec fails
- **THEN** the rejection SHALL carry `{ code: number | "ENOENT", stderr,
  killed }`, with `killed: true` for timeout or output-limit kills
- **AND** this shape SHALL be pinned by platform-level contract tests against
  the real implementation

#### Scenario: No direct child_process usage outside the platform layer

- **WHEN** production code under `packages/*/src` spawns a process
- **THEN** it SHALL use the platform wrappers; a repo-invariant test SHALL
  fail on value-imports of `node:child_process` outside the platform package
  and test/e2e helpers

### Requirement: Vendor Session Id Binding Validation

`ocr session bind-vendor-id` SHALL validate the supplied vendor session id
against an argv-safety syntax class (`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/`)
before persisting it, because a bound id is sticky and later becomes spawn
argv (`--session <id>`). Per-vendor id grammars SHALL NOT be enforced —
vendors change formats silently, and the caller is an AI orchestrator
mid-workflow.

#### Scenario: Argv-unsafe session id is rejected at bind time

- **WHEN** the orchestrator runs `ocr session bind-vendor-id <agent>` with an
  id containing whitespace, quotes, or shell metacharacters
- **THEN** the command SHALL exit non-zero naming the offending character
- **AND** nothing SHALL be persisted (the bind remains available)

#### Scenario: Real vendor id shapes are accepted

- **WHEN** binding a Claude Code UUID or an OpenCode `ses_…` id
- **THEN** the bind SHALL succeed unchanged

### Requirement: Round Metadata Validation Contract

The CLI SHALL be the sole enforcement boundary for `round-meta.json` structural
and value-domain validity. At `ocr state complete-round`, validation SHALL run
**before** any write, and any violation SHALL abort the command with the
`SCHEMA_INVALID` exit code, writing no file and appending no event, so an
orchestrating agent can detect the failure, correct the payload, and retry
without leaving partial state.

The validator SHALL enforce, in addition to the existing category and severity
enums:

- **Verdict enum** — `verdict` SHALL be exactly one of the canonical merge-gate
  states `APPROVE`, `REQUEST CHANGES`, `NEEDS DISCUSSION`, sourced from the
  shared `@open-code-review/platform` vocabulary. The writer SHALL NOT coerce
  aliases; an off-vocabulary verdict is rejected.
- **Finding title floor** — each finding `title` SHALL be a string whose trimmed
  length meets a minimum threshold, rejecting degenerate titles such as `"s"`.
- **Directional counts cross-check** — when `synthesis_counts` is present, each
  count SHALL be ≥ 0 and SHALL NOT exceed the tally derived from
  `findings[].category` (a deduplicated synthesis count may be lower than the
  derived tally, but never higher).
- **Directional verdict ↔ blocker-count cross-check** — the recorded `verdict`
  SHALL be consistent with the **blocker count**, where the blocker count is the
  single deduplicated value `resolveRoundCounts(meta).blockerCount` from
  `@open-code-review/platform` (which prefers `synthesis_counts.blockers` when
  present, else derives the `blocker`-category tally) — NOT the raw
  `deriveCounts().blocker` tally. "Blocker" here is exactly the canonical
  `blocker` finding category (one of `blocker / should_fix / suggestion /
  style`); `should_fix` is residual work, not a blocker. The rule:
  - `REQUEST CHANGES` SHALL require a blocker count ≥ 1;
  - `APPROVE` SHALL require a blocker count of 0;
  - `NEEDS DISCUSSION` SHALL impose no blocker-count constraint.
  Because the blocker count is the deduplicated `resolveRoundCounts` value, a
  round whose raw `blocker`-category tally is ≥ 1 but whose
  `synthesis_counts.blockers` legitimately deduplicates to 0 is treated as
  having 0 blockers — consistent with the sibling "Deduplicated synthesis count
  is accepted" scenario, so the two checks never contradict each other. A
  violation is rejected with the same `SCHEMA_INVALID` posture (no file, no
  event), and the error message SHALL name both the verdict and the offending
  blocker count.

#### Scenario: Off-vocabulary verdict is rejected
- **WHEN** an agent pipes round metadata whose `verdict` is not one of `APPROVE`, `REQUEST CHANGES`, `NEEDS DISCUSSION` (e.g. `accept_with_followups`)
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code
- **AND** SHALL write no `round-meta.json` and append no `round_completed` event
- **AND** the error message SHALL echo the offending value and enumerate the legal verdict set

#### Scenario: Degenerate finding title is rejected
- **WHEN** an agent pipes round metadata containing a finding whose trimmed `title` is below the minimum length (e.g. `"s"`)
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code and write nothing

#### Scenario: Inflated synthesis count is rejected
- **WHEN** an agent pipes round metadata whose `synthesis_counts.X` exceeds the count of findings with the corresponding category
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code and write nothing

#### Scenario: Deduplicated synthesis count is accepted
- **WHEN** an agent pipes round metadata whose `synthesis_counts.X` is less than or equal to the derived category tally (legitimate cross-reviewer deduplication)
- **THEN** validation SHALL pass and the round SHALL complete normally

#### Scenario: APPROVE with a non-zero blocker count is rejected
- **WHEN** an agent pipes round metadata whose `verdict` is `APPROVE` but whose `resolveRoundCounts().blockerCount` is ≥ 1
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code and write nothing
- **AND** the error message SHALL name the verdict and the offending blocker count

#### Scenario: REQUEST CHANGES with a zero blocker count is rejected
- **WHEN** an agent pipes round metadata whose `verdict` is `REQUEST CHANGES` but whose `resolveRoundCounts().blockerCount` is 0
- **THEN** `complete-round` SHALL exit with the `SCHEMA_INVALID` code and write nothing

#### Scenario: APPROVE with blocker findings deduplicated to zero is accepted
- **WHEN** an agent pipes round metadata whose `verdict` is `APPROVE`, whose findings include `blocker`-category entries (raw tally ≥ 1), but whose `synthesis_counts.blockers` legitimately deduplicates to 0
- **THEN** the directional check SHALL use the deduplicated `resolveRoundCounts().blockerCount` of 0 and SHALL PASS
- **AND** this SHALL be consistent with the "Deduplicated synthesis count is accepted" scenario (no contradiction between the two checks)

#### Scenario: NEEDS DISCUSSION is unconstrained on blocker count
- **WHEN** an agent pipes round metadata whose `verdict` is `NEEDS DISCUSSION`, with any blocker count
- **THEN** the directional verdict ↔ blocker-count check SHALL pass (subject to the other checks)

#### Scenario: Valid canonical verdict completes the round
- **WHEN** an agent pipes round metadata with a canonical `verdict`, titles meeting the floor, consistent counts, and a verdict directionally consistent with the deduplicated blocker count
- **THEN** `complete-round` SHALL validate, write `round-meta.json`, append the `round_completed` event, advance the round, and transition the phase — all in one transaction

