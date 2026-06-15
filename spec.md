# Dashboard Specification

## Purpose

The OCR Dashboard is a local web application that provides an interactive, real-time UI for orchestrating code reviews, navigating Code Review Maps with dependency graphs, tracking review progress, rendering markdown artifacts, and executing CLI commands — all backed by a single SQLite database that serves as the unified source of truth for the CLI, AI agents, and the dashboard.

### Problem Statement

OCR currently tracks code review and map workflow state via `state.json` files and filesystem artifacts (`.ocr/sessions/`), rendered to terminal by the CLI's `ocr progress` command. This architecture has five fundamental limitations:

1. **No persistent progress tracking** — Terminal output is ephemeral. Once `ocr progress` exits, all visual state is gone. There's no way to pick up where you left off across sessions.

2. **No interactive navigation** — The markdown-based Code Review Map (`map.md`) is a static document. Reviewing a 100+ file changeset requires manually scrolling, mentally tracking which files have been reviewed, and jumping between sections with no visual aid for understanding dependencies.

3. **No structured finding management** — The final review (`final.md`) is a markdown file. There's no way to track which findings have been addressed, acknowledged, or deferred without manually editing the file.

4. **Split state / no single source of truth** — Session state lives in `state.json`, artifact details live on the filesystem, and there is no unified queryable store. The CLI, agents, and any future UI must each implement their own state reconciliation logic, leading to drift and complexity.

5. **No operational control plane** — There is no way for a developer to trigger CLI commands, inspect orchestration state, or interact with the review pipeline outside of the terminal. The feedback loop between the agent workflow and the developer is entirely passive.

### Target User

A software engineer who uses OCR for code review and needs to:
- Navigate and understand a large changeset (50–200+ files)
- Track their progress reviewing files section-by-section
- Understand dependency relationships between changed files
- Triage and track review findings
- Resume review progress across multiple sessions
- View richly rendered markdown artifacts (reviews, maps, discourse, final synthesis)
- Execute OCR CLI commands without leaving the browser
- Monitor live orchestration state as AI agents run reviews

### Scope

The dashboard is a **local-only** application with **read and write** capabilities against the shared SQLite store. It does NOT:
- Require authentication or user accounts
- Communicate with external services (no telemetry, no cloud sync)
- Get published to npm (internal package only)

It DOES:
- Serve as the primary visual interface for all OCR data
- Execute CLI commands on behalf of the user (e.g., `ocr state`, `ocr init`, review triggers)
- Share the same SQLite database that agents and the CLI write to and read from
- Coexist with the terminal UI — `ocr progress` continues to work independently by reading from the same SQLite store

---

## Architecture Context

### Monorepo Structure

```
packages/
├── agents/        ← published @open-code-review/agents (AI agent prompts + state CLI calls)
├── dashboard/     ← internal only (Express/Hono server + React client, private: true)
└── cli/           ← published @open-code-review/cli (embeds dashboard build output)
```

Only `@open-code-review/cli` and `@open-code-review/agents` are published to npm. The dashboard package is a build-time dependency of the CLI — its compiled output is copied into the CLI's `dist/dashboard/` directory. End users get the dashboard by installing the CLI.

### Data Flow — SQLite as Single Source of Truth

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SQLite (.ocr/data/ocr.db)                     │
│            ★ Single source of truth for ALL state ★                  │
└──────┬───────────────┬───────────────────┬───────────────────────────┘
       │ writes         │ reads/writes       │ reads/writes
       ▼               ▼                   ▼
  AI Agents         CLI (`ocr`)        Dashboard Server
  (via `ocr state`  (progress,          (Express/Hono +
   CLI commands)     state, sync)        Socket.IO)
                                            │
                                   Socket.IO events
                                            │
                                            ▼
                                      React Client
                                   (socket.io-client)
```

**Write paths into SQLite:**
1. **`ocr state` CLI commands** — Called by AI agents during workflow execution. Write session-level orchestration state (phase, round, status, workflow events) to SQLite tables. This is the primary, real-time write path.
2. **FilesystemSync service** — Runs inside the dashboard server. On startup, scans `.ocr/sessions/` and parses markdown artifacts (reviewer outputs, findings, map sections, files) into granular SQLite tables. Watches for filesystem changes via chokidar while running.
3. **Dashboard server** — Writes user interaction data (file review progress, finding triage status, notes) and accepts CLI command execution requests.

**Why `ocr state` writes to SQLite (not `state.json`):** The entire system converges on a single queryable store. `state.json` is **deprecated** as the primary state medium — it MAY be written as a backward-compatible side-effect for `ocr progress` terminal fallback, but SQLite is authoritative. This eliminates state reconciliation bugs, enables rich queries (e.g., "all sessions with unresolved blockers"), and gives the dashboard instant visibility into agent progress.

### Real-Time Event Architecture (Socket.IO)

```
┌─────────────┐          ┌──────────────────────┐         ┌──────────────┐
│  AI Agent   │──ocr ──▶│  Dashboard Server     │◀──ws──▶│ React Client │
│  (writes    │  state   │  (Express + Socket.IO)│         │ (socket.io-  │
│   to DB)    │  CLI     │                       │         │  client)     │
└─────────────┘          │  • Watches SQLite WAL │         └──────────────┘
                         │  • Watches filesystem │
                         │  • Emits events:      │
                         │    session:updated     │
                         │    phase:changed       │
                         │    artifact:created    │
                         │    command:output       │
                         └──────────────────────────┘
```

The server detects changes via:
1. **SQLite write hooks / WAL polling** — When `ocr state` commands write to the DB, the server detects the change and emits a Socket.IO event to all connected clients.
2. **Filesystem watcher (chokidar)** — When new markdown artifacts appear, the server parses them into SQLite and emits an `artifact:created` event.
3. **Command execution** — When the dashboard user triggers a CLI command, the server spawns the process, streams stdout/stderr over a `command:output` socket event, and persists the result.

Clients subscribe to relevant event channels (e.g., `session:{id}`) and update local state via React Query cache invalidation or direct state patches. **No polling is required** — all updates are push-based via Socket.IO.

### CLI Commands

| Command | Description |
|---------|-------------|
| `ocr init` | Install OCR for one or more AI coding environments |
| `ocr progress` | Live terminal UI showing workflow progress (reads from SQLite) |
| `ocr state init\|transition\|close\|show\|sync` | Manage session state in SQLite (used by AI agents) |
| `ocr update` | Re-copy agent assets to local `.ocr/` directory |
| `ocr dashboard` | **NEW** — Start the dashboard web server + Socket.IO |

---

## Functional Requirements

### FR-1: Dashboard Command

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

### FR-2: Session List

The dashboard SHALL display a list of all OCR sessions from SQLite, with real-time updates via Socket.IO.

#### Scenario: Sessions exist

- **GIVEN** one or more sessions exist in SQLite
- **WHEN** user opens the dashboard
- **THEN** sessions are listed, sorted by `updated_at` descending (most recent first)
- **AND** each session shows: branch name, status badge (active/closed), current phase, workflow type (review/map), start date, elapsed time

#### Scenario: No sessions

- **GIVEN** no sessions exist
- **WHEN** user opens the dashboard
- **THEN** an empty state is shown with instructions to run `/ocr-review` or `/ocr-map`
- **AND** a "Run Review" action button is available (see FR-11)

#### Scenario: Filter by status

- **WHEN** user filters by "Active" or "Closed"
- **THEN** only sessions matching the filter are shown

#### Scenario: Filter by workflow type

- **WHEN** user filters by "Review" or "Map"
- **THEN** only sessions matching the workflow type are shown

#### Scenario: Real-time session appearance

- **GIVEN** the dashboard is open on the sessions list
- **WHEN** an AI agent creates a new session via `ocr state init`
- **THEN** the server emits a `session:created` Socket.IO event
- **AND** the new session appears in the list without page refresh

---

### FR-3: Session Detail

The dashboard SHALL display a detail view for a single session, with tabs for Review and Map sub-workflows and a live phase timeline.

#### Scenario: Session with review only

- **GIVEN** a session with `workflow_type = 'review'`
- **WHEN** user clicks the session
- **THEN** the review tab is shown with phase timeline and round navigation

#### Scenario: Session with map only

- **GIVEN** a session with `workflow_type = 'map'`
- **WHEN** user clicks the session
- **THEN** the map tab is shown with run navigation

#### Scenario: Session with both review and map

- **GIVEN** a session that has both review rounds and map runs
- **WHEN** user clicks the session
- **THEN** both Review and Map tabs are available
- **AND** the most recently active workflow tab is shown first

#### Scenario: Phase timeline with live updates

- **WHEN** viewing a session detail
- **THEN** a visual timeline shows all workflow phases with status indicators (pending, active, complete)
- **AND** timestamps are shown for completed phases
- **AND** when the server emits `phase:changed` for this session, the timeline updates in place without refresh

---

### FR-4: Review Round View

The dashboard SHALL display a detailed view of a single review round with rendered reviewer outputs, parsed findings, and triage controls.

#### Scenario: View round with completed reviews

- **GIVEN** a round with 4 reviewer output files parsed into SQLite
- **WHEN** user navigates to the round
- **THEN** 4 reviewer cards are shown, each displaying: reviewer type (principal/quality/security/testing), instance number, finding count

#### Scenario: View rendered reviewer output

- **WHEN** user clicks a reviewer card
- **THEN** the full reviewer markdown output is rendered using `react-markdown` with syntax highlighting
- **AND** code blocks, tables, and headings are styled consistently with the shadcn design system

#### Scenario: View findings table

- **WHEN** user opens the findings section
- **THEN** all parsed findings are shown in a sortable, filterable data table with columns: severity, title, file path, line range, blocker status, triage status
- **AND** findings are sorted by severity (critical → info) by default

#### Scenario: Finding status tracking

- **WHEN** user changes a finding's status (unread → read → acknowledged → fixed → wont_fix)
- **THEN** the status is persisted to SQLite (`user_finding_progress` table)
- **AND** the status is preserved across dashboard restarts

#### Scenario: View verdict (rendered markdown)

- **GIVEN** `final.md` content has been parsed into SQLite
- **WHEN** viewing the round
- **THEN** a verdict badge is shown: APPROVE (green), REQUEST CHANGES (red), or NEEDS DISCUSSION (yellow)
- **AND** blocker count, suggestion count, and "should fix" count are displayed
- **AND** the full `final.md` content is rendered as rich markdown below the summary

#### Scenario: View discourse (rendered markdown)

- **GIVEN** `discourse.md` content has been parsed into SQLite
- **WHEN** user clicks "View Discourse"
- **THEN** the discourse content is rendered as rich markdown with AGREE/CHALLENGE/CONNECT/SURFACE sections visually differentiated

---

### FR-5: Code Review Map View

The dashboard SHALL display an interactive view of a Code Review Map run, replacing the static markdown experience.

#### Scenario: View map sections

- **GIVEN** a completed map run with data parsed into SQLite
- **WHEN** user navigates to the map run
- **THEN** sections are displayed as cards, each showing: section title, description, file count, progress bar (reviewed/total)
- **AND** sections are ordered by section number

#### Scenario: View files within section

- **WHEN** user expands a section card
- **THEN** all files in that section are listed with: file path, role description, lines added/deleted, review checkbox
- **AND** files are ordered by `display_order`

#### Scenario: Mark file as reviewed

- **WHEN** user checks a file's review checkbox
- **THEN** the `user_file_progress` table is updated (`is_reviewed = 1, reviewed_at = NOW()`)
- **AND** the section progress bar updates
- **AND** the global progress counter updates
- **AND** the state persists across dashboard restarts

#### Scenario: Unmark file as reviewed

- **WHEN** user unchecks a file's review checkbox
- **THEN** the `user_file_progress` table is updated (`is_reviewed = 0, reviewed_at = NULL`)
- **AND** progress indicators update accordingly

#### Scenario: Clear all progress

- **WHEN** user clicks "Clear Progress" for a map run
- **THEN** a confirmation dialog appears
- **AND** upon confirmation, all `user_file_progress` rows for that run are reset to `is_reviewed = 0`

#### Scenario: Global progress indicator

- **WHEN** viewing a map run
- **THEN** a header shows: "X / Y files reviewed" and a percentage progress bar
- **AND** this updates in real time as files are checked/unchecked

#### Scenario: View rendered map.md

- **WHEN** user clicks "View Raw Map"
- **THEN** the full `map.md` content is rendered as rich markdown using `react-markdown`

---

### FR-6: Dependency Graph

The dashboard SHALL render Mermaid-based dependency diagrams showing relationships between map sections and files.

#### Scenario: Section-level graph

- **GIVEN** a map run with `flow-analysis.md`
- **WHEN** user views the map run
- **THEN** a section-level Mermaid graph is rendered showing dependencies between sections
- **AND** each node shows: section title, file count, review progress

#### Scenario: File-level drill-down

- **WHEN** user clicks a section node in the graph
- **THEN** the graph transitions to show file-level dependencies within that section
- **AND** a "Back to sections" control is available

#### Scenario: No flow analysis

- **GIVEN** a map run where `flow-analysis.md` does not exist or cannot be parsed
- **WHEN** user views the map run
- **THEN** the dependency graph section is hidden (not shown as an error)

#### Scenario: Graph rendering

- **THEN** Mermaid is lazy-loaded (not included in initial bundle)
- **AND** graphs render as SVG for crisp display at any zoom level

---

### FR-7: Real-Time Updates via Socket.IO

The dashboard SHALL reflect changes to session state in near-real-time via persistent WebSocket connections (Socket.IO). **No polling.** All data updates are push-based.

#### Scenario: Agent updates state during review

- **GIVEN** the dashboard is open and showing a session
- **WHEN** an AI agent runs `./bin/ocr state transition --phase reviews --phase-number 4`
- **THEN** the CLI writes to SQLite
- **AND** the dashboard server detects the write and emits a `phase:changed` event
- **AND** the client receives the event and updates the phase timeline within 1 second

#### Scenario: New session appears

- **GIVEN** the dashboard is open on the sessions list
- **WHEN** an AI agent starts a new review via `ocr state init`
- **THEN** the server emits a `session:created` event
- **AND** the new session appears in the list within 1 second

#### Scenario: Filesystem artifact created

- **GIVEN** the dashboard is open and showing a review round
- **WHEN** a reviewer output file is written to `rounds/round-1/reviews/principal-1.md`
- **THEN** chokidar detects the file, FilesystemSync parses it into SQLite
- **AND** the server emits an `artifact:created` event
- **AND** the reviewer card appears within 3 seconds

#### Scenario: Socket.IO connection lifecycle

- **WHEN** the React client connects to the dashboard server
- **THEN** a Socket.IO connection is established on the same port as HTTP
- **AND** the client subscribes to global events (`session:created`, `session:updated`)
- **AND** when viewing a specific session, the client joins a `session:{id}` room for scoped events
- **AND** if the connection drops, Socket.IO automatically reconnects with exponential backoff

#### Socket.IO Event Catalog

| Event | Direction | Payload | Trigger |
|-------|-----------|---------|---------|
| `session:created` | server → client | `{ session }` | New session inserted into SQLite |
| `session:updated` | server → client | `{ sessionId, changes }` | Session row updated |
| `session:closed` | server → client | `{ sessionId }` | Session status set to closed |
| `phase:changed` | server → client | `{ sessionId, phase, phaseNumber }` | Phase transition written to DB |
| `artifact:created` | server → client | `{ sessionId, type, id }` | FilesystemSync inserts artifact |
| `artifact:updated` | server → client | `{ sessionId, type, id }` | Artifact re-parsed/updated |
| `command:started` | server → client | `{ commandId, command }` | CLI command spawned |
| `command:output` | server → client | `{ commandId, stream, data }` | stdout/stderr chunk |
| `command:finished` | server → client | `{ commandId, exitCode }` | CLI command completed |
| `command:run` | client → server | `{ command, args }` | User requests CLI execution |

---

### FR-8: Statistics / Home Page

The dashboard SHALL display aggregate statistics on the home page.

#### Scenario: View stats

- **WHEN** user opens the dashboard home page
- **THEN** stat cards show: total sessions, active sessions, completed reviews, completed maps, total files tracked, unresolved blockers
- **AND** a list of the 10 most recent sessions is shown
- **AND** stats update in real-time via Socket.IO events

---

### FR-9: User Notes

The dashboard SHALL allow users to attach freeform notes to sessions, rounds, findings, map runs, sections, and files.

#### Scenario: Add note to finding

- **WHEN** user adds a note to a review finding
- **THEN** the note is saved to `user_notes` table with `target_type = 'finding'`
- **AND** the note is displayed alongside the finding

#### Scenario: Edit note

- **WHEN** user edits an existing note
- **THEN** `updated_at` is updated and content is replaced

#### Scenario: Delete note

- **WHEN** user deletes a note
- **THEN** the row is removed from `user_notes`

---

### FR-10: Theme Support

The dashboard SHALL support light, dark, and system-preference themes with an aesthetic consistent with shadcn/ui, Uber, Airbnb, and Anthropic design systems.

#### Scenario: System preference (default)

- **GIVEN** user has not set a theme preference
- **WHEN** the dashboard loads
- **THEN** the theme matches the OS preference (`prefers-color-scheme`)

#### Scenario: Toggle theme

- **WHEN** user clicks the theme toggle
- **THEN** the theme cycles through: system → light → dark → system
- **AND** the preference is saved to `localStorage`
- **AND** the preference persists across sessions

#### Scenario: Design language

- **WHEN** the dashboard renders any page
- **THEN** the visual language SHALL follow these principles:
  - **Typography**: Clean, hierarchical type scale (Inter or system font stack)
  - **Color**: Neutral-first palette with purposeful accent colors for status indicators
  - **Spacing**: Generous whitespace, 4px grid system
  - **Cards**: Subtle borders, no heavy shadows — consistent with shadcn/ui defaults
  - **Data density**: Optimize for scannability — tables, badges, and progress bars over prose
  - **Motion**: Subtle, purposeful transitions (no gratuitous animation)

---

### FR-11: CLI Command Execution

The dashboard SHALL allow users to execute OCR CLI commands from the browser, with real-time output streaming via Socket.IO.

#### Scenario: Run a CLI command

- **WHEN** user selects a command from the command palette or clicks an action button (e.g., "Run Review")
- **THEN** the client emits a `command:run` Socket.IO event with the command and arguments
- **AND** the server spawns the CLI process (`node dist/index.js <command> <args>`)
- **AND** stdout/stderr are streamed back to the client via `command:output` events
- **AND** the terminal output is rendered in a panel using a monospace font with ANSI color support

#### Scenario: Command completes

- **WHEN** the spawned CLI process exits
- **THEN** the server emits a `command:finished` event with the exit code
- **AND** the output panel shows success (exit 0) or failure styling

#### Scenario: Available commands

- **WHEN** user opens the command palette
- **THEN** the following commands are available:
  - `ocr init` — Initialize OCR
  - `ocr update` — Update OCR assets
  - `ocr state sync` — Force sync filesystem → SQLite
  - `ocr state show` — Display current session state
- **AND** commands that mutate state require a confirmation step

#### Scenario: Concurrent command guard

- **GIVEN** a command is already running
- **WHEN** user attempts to start another command
- **THEN** a warning is shown that a command is in progress
- **AND** the user may choose to wait or cancel the running command

---

### FR-12: Markdown Artifact Rendering

The dashboard SHALL render all markdown artifacts (reviews, discourse, final synthesis, maps, flow analysis) as rich, styled HTML using a markdown rendering pipeline.

#### Scenario: Render reviewer output

- **WHEN** user views a reviewer's output
- **THEN** the raw markdown stored in SQLite (or referenced on disk) is rendered via `react-markdown` + `rehype-highlight` + `remark-gfm`
- **AND** code blocks have syntax highlighting matching the dashboard's theme
- **AND** tables, headings, lists, and inline code are styled per the shadcn design system

#### Scenario: Render final.md

- **WHEN** user views the final synthesis
- **THEN** the full `final.md` is rendered as rich markdown
- **AND** verdict badges, finding severity indicators, and section headings are enhanced with dashboard-native components overlaid on the rendered markdown

#### Scenario: Render discourse.md

- **WHEN** user views the discourse
- **THEN** AGREE/CHALLENGE/CONNECT/SURFACE response types are visually distinguished (e.g., colored left border, icon per type)
- **AND** the discourse is rendered as rich markdown

#### Scenario: Render map.md

- **WHEN** user clicks "View Raw Map"
- **THEN** the full map markdown is rendered with styled tables, checkboxes, and section headings

#### Scenario: Render flow-analysis.md

- **WHEN** user views the flow analysis
- **THEN** the flow analysis markdown is rendered with code blocks and file references linkified to the section/file views in the dashboard

---

## Non-Functional Requirements

### NFR-1: Zero Native Dependencies

The dashboard SHALL not require native compilation (no `node-gyp`, no platform-specific prebuilds).

**Rationale**: OCR targets diverse development environments. `npm install` must work reliably on macOS, Linux, and Windows without build tools.

**Implementation**: Use `sql.js` (WASM-based SQLite) instead of `better-sqlite3`. Socket.IO, Express/Hono, and all other dependencies must be pure JavaScript/WASM.

---

### NFR-2: Zero Startup Cost for Non-Dashboard Commands

The dashboard code SHALL NOT be loaded unless the user runs `ocr dashboard`.

**Rationale**: Commands like `ocr init`, `ocr progress`, and `ocr state` must remain fast. The dashboard adds significant dependencies (React, Socket.IO, sql.js) that should not impact CLI startup time.

**Implementation**: The CLI uses `await import(...)` (dynamic import) to load the dashboard server only when the `dashboard` command is invoked. The dashboard's build output lives in `dist/dashboard/` — a separate directory from `dist/index.js`.

**Exception**: `ocr state` commands share the same `sql.js`-based database access layer as the dashboard. This layer is lightweight and loaded only by `ocr state` and `ocr dashboard` commands.

---

### NFR-3: Embedded Deployment

The dashboard SHALL be fully self-contained within the CLI's npm package. No separate installation step, no external process, no Docker container.

**Implementation**:
- Dashboard client is built by Vite → `packages/dashboard/dist/client/` (static HTML/JS/CSS)
- Dashboard server is bundled by esbuild → `packages/dashboard/dist/server.js` (single file, includes Socket.IO server)
- CLI build copies `packages/dashboard/dist/` → `packages/cli/dist/dashboard/`
- CLI dynamically imports `dist/dashboard/server.js` at runtime
- Published `@open-code-review/cli` tarball includes `dist/dashboard/` in its `files` array

---

### NFR-4: Build Pipeline Integration

The dashboard build SHALL integrate with the existing Nx monorepo build system.

**Requirements**:
- `nx build dashboard` produces `packages/dashboard/dist/` (server.js + client/)
- `nx build cli` depends on `nx build dashboard` (via `dependsOn: ["^build"]`)
- CLI's postbuild step copies dashboard dist into CLI dist
- `nx release` excludes the dashboard package (it is `private: true`)
- `pnpm install` at the monorepo root resolves the dashboard as a workspace dependency

---

### NFR-5: Development Experience

The dashboard SHALL support a hot-reloading development workflow.

**Requirements**:
- `nx dev dashboard` (or `pnpm dev:dashboard`) starts both:
  - Vite dev server on port 5173 (client with HMR + Socket.IO client auto-connecting to API server)
  - tsx watch on `src/server/dev.ts` (API + Socket.IO server on port 4173 with auto-restart)
- Vite proxies `/api/*` requests to the API server
- Vite proxies `/socket.io/*` WebSocket connections to the API server
- The API server resolves the `.ocr/` directory relative to the monorepo root (not `packages/dashboard/`), by walking up the directory tree
- Static file serving (serveStatic) is disabled in dev mode — Vite handles client assets

---

### NFR-6: Data Durability

All data (workflow state, artifacts, user interactions) SHALL survive:
- Dashboard restarts
- Full filesystem re-syncs (re-import from `.ocr/sessions/`)
- CLI upgrades
- Concurrent writes from agents, CLI, and dashboard

**Implementation**:
- SQLite WAL mode is enabled for concurrent read/write safety
- User tables (`user_file_progress`, `user_finding_progress`, `user_notes`) reference workflow tables via foreign keys with `ON DELETE CASCADE`
- FilesystemSync uses `INSERT OR REPLACE` (upsert) for workflow tables, never drops user tables
- The SQLite file at `.ocr/data/ocr.db` is gitignored
- `state.json` MAY be written as a backward-compatible side-effect but is NOT the source of truth

---

### NFR-7: Performance

#### Page Load
- Initial dashboard load (cold) SHALL complete in under 2 seconds on localhost
- Subsequent navigation SHALL be instant (SPA with client-side routing)
- Socket.IO connection SHALL be established within 500ms of page load

#### API Response Time
- All REST API endpoints SHALL respond in under 100ms for typical session counts (< 100 sessions)
- Socket.IO event propagation (DB write → client update) SHALL complete in under 1 second

#### Memory
- The dashboard server process SHALL use less than 100MB RSS for typical usage (< 100 sessions, < 1000 files)

#### Bundle Size
- Client JS bundle SHALL be under 500KB gzipped (excluding Mermaid, which is lazy-loaded)
- Mermaid SHALL be loaded on-demand, only when a dependency graph is displayed
- Socket.IO client adds ~50KB gzipped — acceptable given it replaces polling logic

---

### NFR-8: Browser Support

The dashboard SHALL work in the latest stable versions of:
- Chrome / Chromium
- Firefox
- Safari
- Edge

No IE11 or legacy browser support required.

---

### NFR-9: Accessibility

- All interactive elements SHALL be keyboard-navigable
- Color SHALL NOT be the only means of conveying status (use icons/text alongside color)
- Sufficient contrast ratios per WCAG 2.1 AA in both light and dark themes

---

### NFR-10: Extensibility

The dashboard architecture SHALL be designed for extensibility, enabling future features without architectural rework.

**Requirements**:
- **Plugin-ready server**: The Express/Hono server uses a middleware/route registration pattern that allows new feature modules to register routes and Socket.IO event handlers without modifying core server code.
- **Feature-sliced client**: The React client is organized by feature (e.g., `features/sessions/`, `features/review/`, `features/map/`, `features/commands/`), with shared components in `components/ui/`. New features add a new directory — they do not require edits to existing feature directories.
- **Socket.IO namespace isolation**: Each major feature area MAY use a Socket.IO namespace (e.g., `/sessions`, `/commands`) to avoid event name collisions as the system grows.
- **Schema migrations**: The database uses a versioned migration system (`schema_version` table). New features add migration files — they do not modify existing migrations.
- **Shared DB access layer**: A `@open-code-review/db` shared module (or internal package) provides typed SQLite access used by both the CLI (`ocr state`) and the dashboard server. This ensures schema consistency and prevents drift.

---

## Data Model

### SQLite Schema

**Location**: `.ocr/data/ocr.db` (created on first `ocr dashboard` or first `ocr state` command, gitignored)

The schema is split into three layers:

#### 1. Workflow State Layer (written by agents via `ocr state` CLI)

These tables are the **primary write target** for AI agents. When an agent calls `ocr state init`, `ocr state transition`, or `ocr state close`, these tables are updated directly in SQLite. This is the authoritative source of orchestration state.

| Table | Writer | Description |
|-------|--------|-------------|
| `sessions` | `ocr state` CLI | One row per session. Core orchestration state (phase, round, status). |
| `orchestration_events` | `ocr state` CLI | Append-only event log. Every phase transition, round start, and status change is recorded as an immutable event. Enables audit trails, timeline reconstruction, and debugging. |

#### 2. Artifact Layer (written by FilesystemSync)

These tables are populated by the FilesystemSync service when it parses markdown artifacts from `.ocr/sessions/`. AI agents write markdown files to the filesystem; FilesystemSync reads them and inserts structured data into SQLite.

| Table | Source | Description |
|-------|--------|-------------|
| `review_rounds` | FilesystemSync | One row per `rounds/round-{n}/` directory. |
| `reviewer_outputs` | FilesystemSync | One row per `reviews/{type}-{n}.md`. Includes raw markdown content. |
| `review_findings` | FilesystemSync | Parsed from reviewer markdown. Individual issues/suggestions. |
| `markdown_artifacts` | FilesystemSync | Raw markdown content for `final.md`, `discourse.md`, `map.md`, `flow-analysis.md`, etc. Keyed by session + artifact type. Used by the markdown rendering pipeline (FR-12). |
| `map_runs` | FilesystemSync | One row per `map/runs/run-{n}/` directory. |
| `map_sections` | FilesystemSync | Parsed from `map.md` section headings and file tables. |
| `map_files` | FilesystemSync | Parsed from `map.md` file tables. One row per changed file. |

#### 3. User Interaction Layer (written by dashboard)

These tables are written exclusively by the dashboard UI. They are never touched by FilesystemSync or `ocr state` commands. They reference workflow/artifact tables via foreign keys.

| Table | Description |
|-------|-------------|
| `user_file_progress` | Checkbox state for map file review tracking. References `map_files`. |
| `user_finding_progress` | Finding triage status (unread/read/acknowledged/fixed/wont_fix). References `review_findings`. |
| `user_notes` | Freeform notes attachable to any entity (session, round, finding, run, section, file). |
| `command_executions` | Log of CLI commands executed from the dashboard (FR-11). Includes command, args, exit code, output. |
| `schema_version` | Migration tracking. |

### Full Schema DDL

```sql
-- =============================================
-- 1. WORKFLOW STATE LAYER (written by agents via ocr state CLI)
-- =============================================

CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,     -- "2026-01-29-feat-auth"
    branch          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','closed')),
    workflow_type   TEXT CHECK (workflow_type IN ('review','map')),
    current_phase   TEXT NOT NULL DEFAULT 'context',
    phase_number    INTEGER NOT NULL DEFAULT 1,
    current_round   INTEGER,
    current_map_run INTEGER,
    started_at      TEXT NOT NULL,        -- ISO 8601
    updated_at      TEXT NOT NULL,        -- ISO 8601
    session_dir     TEXT NOT NULL         -- relative path to .ocr/sessions/{id}/
);

-- Append-only event log for orchestration state changes.
-- Every `ocr state` call inserts a row. Never updated or deleted.
-- Enables: timeline reconstruction, audit trails, debugging, dashboard phase timeline.
CREATE TABLE orchestration_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL CHECK (event_type IN (
        'session_created', 'phase_transition', 'round_started', 'round_completed',
        'map_run_started', 'map_run_completed', 'session_closed', 'error'
    )),
    phase       TEXT,                     -- phase name at time of event
    phase_number INTEGER,                 -- phase number at time of event
    round_number INTEGER,                 -- round number (if applicable)
    map_run_number INTEGER,               -- map run number (if applicable)
    metadata    TEXT,                     -- JSON blob for extensible event data
    created_at  TEXT NOT NULL             -- ISO 8601 timestamp
);

CREATE INDEX idx_orchestration_events_session ON orchestration_events(session_id);
CREATE INDEX idx_orchestration_events_type ON orchestration_events(event_type);

-- =============================================
-- 2. ARTIFACT LAYER (written by FilesystemSync)
-- =============================================

CREATE TABLE review_rounds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    is_complete  INTEGER NOT NULL DEFAULT 0,
    has_discourse INTEGER NOT NULL DEFAULT 0,
    started_at   TEXT,
    verdict      TEXT CHECK (verdict IN ('APPROVE','REQUEST CHANGES','NEEDS DISCUSSION')),
    blocker_count    INTEGER DEFAULT 0,
    should_fix_count INTEGER DEFAULT 0,
    suggestion_count INTEGER DEFAULT 0,
    UNIQUE (session_id, round_number)
);

CREATE TABLE reviewer_outputs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id          INTEGER NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
    reviewer_type     TEXT NOT NULL,        -- "principal", "quality", "security", "testing"
    reviewer_instance INTEGER NOT NULL,     -- 1, 2, etc.
    file_path         TEXT NOT NULL,        -- relative path to .md file on disk
    markdown_content  TEXT,                 -- raw markdown content (for rendering via FR-12)
    finding_count     INTEGER DEFAULT 0,
    parsed_at         TEXT,                 -- when content was last parsed
    UNIQUE (round_id, reviewer_type, reviewer_instance)
);

CREATE TABLE review_findings (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    reviewer_output_id INTEGER NOT NULL REFERENCES reviewer_outputs(id) ON DELETE CASCADE,
    round_id           INTEGER NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
    finding_number     INTEGER NOT NULL,
    title              TEXT NOT NULL,
    severity           TEXT CHECK (severity IN ('critical','high','medium','low','info')),
    file_path          TEXT,
    line_start         INTEGER,
    line_end           INTEGER,
    issue_summary      TEXT,
    suggestion         TEXT,
    is_blocker         INTEGER NOT NULL DEFAULT 0,
    UNIQUE (reviewer_output_id, finding_number)
);

-- Generic store for markdown artifacts (final.md, discourse.md, map.md, flow-analysis.md, etc.)
-- Used by the markdown rendering pipeline (FR-12) to serve rendered content.
CREATE TABLE markdown_artifacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    artifact_type   TEXT NOT NULL CHECK (artifact_type IN (
        'final', 'discourse', 'map', 'flow_analysis', 'topology',
        'requirements_mapping', 'context', 'discovered_standards', 'requirements'
    )),
    round_number    INTEGER,              -- for review artifacts (final, discourse)
    run_number      INTEGER,              -- for map artifacts (map, flow_analysis, topology)
    file_path       TEXT NOT NULL,        -- relative path on disk
    markdown_content TEXT NOT NULL,        -- raw markdown content
    parsed_at       TEXT NOT NULL,         -- ISO 8601
    UNIQUE (session_id, artifact_type, round_number, run_number)
);

CREATE INDEX idx_markdown_artifacts_session ON markdown_artifacts(session_id);

CREATE TABLE map_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_number       INTEGER NOT NULL,
    is_complete      INTEGER NOT NULL DEFAULT 0,
    started_at       TEXT,
    total_files      INTEGER DEFAULT 0,
    total_sections   INTEGER DEFAULT 0,
    has_requirements INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, run_number)
);

CREATE TABLE map_sections (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         INTEGER NOT NULL REFERENCES map_runs(id) ON DELETE CASCADE,
    section_number INTEGER NOT NULL,       -- 0 = "Unrelated Changes"
    title          TEXT NOT NULL,
    description    TEXT,
    flow_summary   TEXT,
    file_count     INTEGER DEFAULT 0,
    UNIQUE (run_id, section_number)
);

CREATE TABLE map_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id    INTEGER NOT NULL REFERENCES map_sections(id) ON DELETE CASCADE,
    run_id        INTEGER NOT NULL REFERENCES map_runs(id) ON DELETE CASCADE,
    file_path     TEXT NOT NULL,
    role          TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    lines_added   INTEGER,
    lines_deleted INTEGER,
    UNIQUE (run_id, file_path)
);

-- =============================================
-- 3. USER INTERACTION LAYER (written by dashboard)
-- =============================================

CREATE TABLE user_file_progress (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    map_file_id INTEGER NOT NULL UNIQUE REFERENCES map_files(id) ON DELETE CASCADE,
    is_reviewed INTEGER NOT NULL DEFAULT 0,
    reviewed_at TEXT
);

CREATE TABLE user_finding_progress (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id INTEGER NOT NULL UNIQUE REFERENCES review_findings(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'unread'
               CHECK (status IN ('unread','read','acknowledged','fixed','wont_fix')),
    updated_at TEXT NOT NULL
);

CREATE TABLE user_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL CHECK (target_type IN (
        'session','round','finding','map_run','map_section','map_file'
    )),
    target_id   TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Log of CLI commands executed from the dashboard (FR-11).
CREATE TABLE command_executions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    command     TEXT NOT NULL,             -- e.g., "ocr state sync"
    args        TEXT,                      -- JSON array of arguments
    status      TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','completed','failed','cancelled')),
    exit_code   INTEGER,
    output      TEXT,                      -- combined stdout/stderr
    started_at  TEXT NOT NULL,
    finished_at TEXT
);

-- =============================================
-- SCHEMA MANAGEMENT
-- =============================================

CREATE TABLE schema_version (
    version     INTEGER NOT NULL,
    applied_at  TEXT NOT NULL,
    description TEXT
);

-- =============================================
-- PRAGMAS (applied on every connection open)
-- =============================================
-- PRAGMA journal_mode = WAL;          -- concurrent reads during writes
-- PRAGMA foreign_keys = ON;           -- enforce referential integrity
-- PRAGMA busy_timeout = 5000;         -- wait 5s on lock contention
```

---

## API Endpoints

All REST endpoints are served under `/api/` by the Express/Hono server. Real-time updates are delivered via Socket.IO (see FR-7 event catalog). REST is used for initial data fetching and mutations; Socket.IO handles all push-based updates.

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all sessions. Supports `?status=active\|closed` and `?type=review\|map` query filters. Returns array sorted by `updated_at` desc. |
| `GET` | `/api/sessions/:id` | Get a single session with round/run counts, current state, and orchestration event timeline. |
| `GET` | `/api/sessions/:id/events` | Get the orchestration event log for a session (from `orchestration_events` table). Used to render the phase timeline. |

### Reviews

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions/:id/rounds` | List all rounds for a session. |
| `GET` | `/api/sessions/:id/rounds/:round` | Get round detail: reviewers, finding counts, verdict, discourse status. |
| `GET` | `/api/sessions/:id/rounds/:round/findings` | List all parsed findings for a round. Supports `?severity=critical\|high\|medium\|low\|info` filter. |
| `GET` | `/api/sessions/:id/rounds/:round/reviewers/:reviewer` | Get a single reviewer output with raw markdown content (for rendering). |

### Maps

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions/:id/runs` | List all map runs for a session. |
| `GET` | `/api/sessions/:id/runs/:run` | Get run detail: sections, file counts, progress stats. |
| `GET` | `/api/sessions/:id/runs/:run/sections` | List sections with per-section progress (files reviewed / total). |
| `GET` | `/api/sessions/:id/runs/:run/sections/:section/files` | List files in a section with review status. |
| `GET` | `/api/sessions/:id/runs/:run/graph` | Get Mermaid graph definition. Supports `?level=section\|file&section=N`. |

### Markdown Artifacts (FR-12)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions/:id/artifacts/:type` | Get raw markdown content for an artifact. `type` is one of: `final`, `discourse`, `map`, `flow_analysis`, `topology`, `requirements_mapping`, `context`, `discovered_standards`, `requirements`. Supports `?round=N` or `?run=N` query params to scope to a specific round/run. |

### User Progress (Mutations)

| Method | Path | Description |
|--------|------|-------------|
| `PATCH` | `/api/map-files/:id/progress` | Toggle file review status. Body: `{ is_reviewed: boolean }` |
| `PATCH` | `/api/findings/:id/progress` | Update finding status. Body: `{ status: 'unread'\|'read'\|'acknowledged'\|'fixed'\|'wont_fix' }` |
| `DELETE` | `/api/sessions/:id/runs/:run/progress` | Clear all file review progress for a map run. |

### Notes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/notes?target_type=X&target_id=Y` | Get notes for a target. |
| `POST` | `/api/notes` | Create a note. Body: `{ target_type, target_id, content }` |
| `PATCH` | `/api/notes/:id` | Update note content. |
| `DELETE` | `/api/notes/:id` | Delete a note. |

### Commands (FR-11)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/commands` | List available CLI commands with descriptions. |
| `GET` | `/api/commands/history` | List past command executions from `command_executions` table. |
| `GET` | `/api/commands/:id` | Get a specific command execution with output. |

Command execution itself uses Socket.IO events (`command:run` → `command:started` → `command:output` → `command:finished`), not REST, for real-time streaming.

### Stats

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stats` | Aggregate stats: total sessions, active sessions, completed reviews, completed maps, total files tracked, unresolved blockers. |

---

## Filesystem Sync

The FilesystemSync service bridges the gap between filesystem artifacts (markdown files written by AI agents) and the SQLite artifact layer. It parses structured data from markdown, stores raw content for rendering (FR-12), and emits Socket.IO events when new or updated artifacts are detected.

**Important**: FilesystemSync does NOT manage session orchestration state (phase, status, round). That is handled exclusively by `ocr state` CLI commands writing directly to the `sessions` and `orchestration_events` tables. FilesystemSync only handles the **artifact layer** — the detailed content that requires markdown parsing.

### Sync Triggers

1. **Dashboard startup** — Full scan of all sessions in `.ocr/sessions/`
2. **File change (chokidar)** — Incremental sync when artifact files are created or modified
3. **Manual** — `ocr state sync` CLI command

### What Gets Synced

| Filesystem Artifact | Target Table(s) | Parsing Logic |
|---------------------|-----------------|---------------|
| `rounds/round-{n}/` directory existence | `review_rounds` | Round number from directory name. `is_complete` from `final.md` existence. |
| `rounds/round-{n}/reviews/{type}-{n}.md` | `reviewer_outputs` + `review_findings` + `markdown_artifacts` | Type and instance from filename. Raw markdown stored in `reviewer_outputs.markdown_content` and `markdown_artifacts`. Findings parsed from `## Finding` / `## Issue` / `## Suggestion` headings. |
| `rounds/round-{n}/final.md` | `review_rounds` (verdict update) + `markdown_artifacts` | Parse verdict from `**APPROVE**` / `**REQUEST CHANGES**` / `**NEEDS DISCUSSION**`. Count blockers and suggestions. Raw markdown stored for rendering. |
| `rounds/round-{n}/discourse.md` | `review_rounds` (`has_discourse`) + `markdown_artifacts` | Boolean flag + raw markdown stored for rendering. |
| `map/runs/run-{n}/` directory existence | `map_runs` | Run number from directory name. |
| `map/runs/run-{n}/map.md` | `map_sections` + `map_files` + `markdown_artifacts` | Parse section headings, file tables, role descriptions, flow summaries. Raw markdown stored for rendering. |
| `map/runs/run-{n}/flow-analysis.md` | `markdown_artifacts` | Raw markdown stored. Mermaid graph definitions computed on-demand from stored content at API request time. |
| `map/runs/run-{n}/topology.md` | `map_runs` (`total_files`) + `markdown_artifacts` | Count files from canonical file list section. Raw markdown stored. |
| `map/runs/run-{n}/requirements-mapping.md` | `markdown_artifacts` | Raw markdown stored for rendering. |
| `context.md`, `discovered-standards.md`, `requirements.md` | `markdown_artifacts` | Session-level shared artifacts. Raw markdown stored. |

### Sync Rules

1. **Upsert, never delete** — FilesystemSync uses `INSERT OR REPLACE` for artifact tables. It never deletes rows.
2. **Skip unchanged** — Compare file `mtime` against `parsed_at` to skip artifacts that haven't changed since last sync.
3. **Never touch user tables** — `user_file_progress`, `user_finding_progress`, `user_notes` are exclusively owned by the dashboard UI.
4. **Never touch orchestration tables** — `sessions` and `orchestration_events` are exclusively owned by `ocr state` CLI. FilesystemSync MAY backfill a `sessions` row if it discovers a session directory with no corresponding DB row (legacy/migration case), but it does NOT update phase, status, or round fields.
5. **Idempotent** — Running a full sync multiple times produces the same result.
6. **Emit events** — After every successful upsert, FilesystemSync emits a Socket.IO event (`artifact:created` or `artifact:updated`) so connected clients receive real-time updates.

---

## Client Pages & Components

### Page Inventory

| Route | Page | Description |
|-------|------|-------------|
| `/` | Home | Stats cards + recent sessions list + quick actions |
| `/sessions` | Sessions | Filterable session list with real-time status updates |
| `/sessions/:id` | Session Detail | Tabs for Reviews / Maps, live phase timeline, orchestration event log |
| `/sessions/:id/rounds/:round` | Review Round | Reviewer cards with rendered markdown, findings data table, verdict |
| `/sessions/:id/rounds/:round/reviewers/:reviewer` | Reviewer Detail | Full rendered markdown output for a single reviewer |
| `/sessions/:id/runs/:run` | Map Run | Dependency graph, section cards, file checkboxes, rendered map |
| `/commands` | Command Center | Command palette, execution history, live output terminal |

### Layout

- **Sidebar**: Navigation links (Home, Sessions, Commands), connection status indicator (Socket.IO)
- **Header**: Theme toggle, breadcrumb navigation, global search (future)
- **Content area**: Main page content with scroll
- **Command drawer**: Slide-up panel for CLI command output (available from any page)

### Feature-Sliced Client Architecture (NFR-10)

```
src/
├── app/                       # App shell, routing, providers
│   ├── App.tsx
│   ├── router.tsx
│   └── providers/
│       ├── SocketProvider.tsx  # Socket.IO context
│       ├── QueryProvider.tsx   # TanStack Query
│       └── ThemeProvider.tsx   # shadcn theme
├── components/
│   ├── ui/                    # shadcn/ui primitives (Button, Card, Badge, etc.)
│   ├── layout/                # Sidebar, Header, Breadcrumb
│   ├── markdown/              # MarkdownRenderer, CodeBlock, DiscourseBlock
│   └── shared/                # StatusBadge, PhaseTimeline, ProgressBar
├── features/
│   ├── home/                  # Stats, recent sessions
│   ├── sessions/              # Session list, session detail, filters
│   ├── review/                # Round view, reviewer detail, findings table
│   ├── map/                   # Map run, sections, files, dependency graph
│   └── commands/              # Command palette, execution panel, output terminal
├── hooks/                     # useSocket, useSession, useArtifact
├── lib/                       # API client, socket client, utils
└── types/                     # Shared TypeScript types
```

### Component Hierarchy (Map Run — most complex page)

```
MapRunPage
├── RunHeader (run number, total files, global progress bar)
├── Tabs
│   ├── Tab: Interactive View
│   │   ├── DependencyGraph (Mermaid, lazy-loaded)
│   │   │   ├── Section-level view (default)
│   │   │   └── File-level view (on section click)
│   │   ├── SectionCard[] (one per section)
│   │   │   ├── SectionHeader (title, description, progress bar)
│   │   │   └── FileRow[] (one per file, collapsible)
│   │   │       ├── Checkbox (review status)
│   │   │       ├── FilePath
│   │   │       ├── RoleDescription
│   │   │       └── ChangeStats (+N −M)
│   │   └── ClearProgressButton
│   └── Tab: Raw Map
│       └── MarkdownRenderer (map.md content from markdown_artifacts)
└── NotesPanel (attachable to section or file)
```

### Component Hierarchy (Review Round)

```
ReviewRoundPage
├── RoundHeader (round number, verdict badge, finding counts)
├── PhaseTimeline (from orchestration_events, live-updated via Socket.IO)
├── Tabs
│   ├── Tab: Findings
│   │   └── FindingsDataTable (sortable, filterable, with triage dropdowns)
│   ├── Tab: Reviewers
│   │   └── ReviewerCard[] (one per reviewer)
│   │       ├── ReviewerHeader (type, instance, finding count)
│   │       └── MarkdownRenderer (reviewer markdown content)
│   ├── Tab: Final Review
│   │   ├── VerdictBanner (APPROVE / REQUEST CHANGES / NEEDS DISCUSSION)
│   │   └── MarkdownRenderer (final.md content)
│   └── Tab: Discourse
│       └── MarkdownRenderer (discourse.md with AGREE/CHALLENGE/CONNECT/SURFACE styling)
└── NotesPanel
```

---

## Technology Stack

### Server

| Concern | Technology | Version | Rationale |
|---------|-----------|---------|-----------|
| HTTP framework | Express or Hono | ^4.x / ^4.6 | Express has native Socket.IO integration via `http.createServer()`. Hono is lighter but requires manual HTTP server setup for Socket.IO. Either works — choose based on team preference. |
| Real-time transport | Socket.IO | ^4.8 | Persistent WebSocket connections with automatic fallback, room-based pub/sub, reconnection handling. Replaces polling entirely. |
| Database | sql.js | ^1.11 | WASM SQLite. Zero native deps, platform agnostic. Drop-in `npm install`. |
| Filesystem watching | chokidar | ^4 | Cross-platform file watcher for incremental artifact sync. |
| Server bundler | esbuild | ^0.24 | Bundles server into single `server.js` file (Socket.IO server included). |
| Dev runner | tsx | ^4.19 | Runs TypeScript server directly in dev mode with watch. |
| Dev parallelism | concurrently | ^9 | Runs Vite + tsx watch in parallel for dev. |

### Client

| Concern | Technology | Version | Rationale |
|---------|-----------|---------|-----------|
| Framework | React | ^19 | User-specified. |
| Bundler | Vite | ^6 | Fast dev server with HMR, optimized production builds. WebSocket proxy support for Socket.IO in dev. |
| UI components | shadcn/ui | new-york style | User-specified. Installs as source code, fully customizable. Provides the consistent, neutral-first aesthetic. |
| Styling | Tailwind CSS | ^4 | User-specified. CSS-first config via `@tailwindcss/vite` plugin. |
| Routing | React Router | ^7 | Standard SPA routing. |
| Data fetching | TanStack Query | ^5 | Caching, loading/error states, cache invalidation triggered by Socket.IO events. |
| Real-time client | socket.io-client | ^4.8 | Connects to Socket.IO server. Used for all push-based updates and command streaming. |
| Markdown rendering | react-markdown | ^9 | Renders raw markdown as React components. Composable with rehype/remark plugins. |
| Markdown: GFM | remark-gfm | ^4 | GitHub Flavored Markdown (tables, strikethrough, task lists, autolinks). |
| Markdown: syntax | rehype-highlight | ^7 | Syntax highlighting for code blocks. Theme-aware (light/dark). |
| Diagrams | Mermaid | ^11 | Client-side lazy-loaded. Renders dependency graphs as SVG. |
| Icons | Lucide React | ^0.468 | Consistent icon set for shadcn/ui. |
| Terminal rendering | @xterm/xterm | ^5 | Renders ANSI-colored CLI output in the command execution panel (FR-11). Lazy-loaded. |

### Shared (CLI + Dashboard)

| Concern | Technology | Rationale |
|---------|-----------|-----------|
| DB access layer | Internal shared module | Typed SQLite access (schema, migrations, queries) used by both `ocr state` CLI commands and the dashboard server. Prevents schema drift. |
| Schema migrations | Custom (versioned SQL files) | Simple `schema_version` table + sequential migration files. No ORM overhead. |

---

## Build & Distribution

### Build Targets

```
packages/dashboard/
  build:client  →  vite build           → dist/client/  (HTML + JS + CSS + socket.io-client)
  build:server  →  esbuild              → dist/server.js (single Node.js bundle, includes Socket.IO server)
  build         →  build:client + build:server (sequential)

packages/cli/
  build         →  esbuild              → dist/index.js (CLI entry point)
  postbuild     →  cp dashboard/dist    → dist/dashboard/ (embed dashboard)
```

### Dependency Graph

```
nx build cli
  └── depends on: nx build dashboard (via "dependsOn": ["^build"])
      ├── build:client (vite — bundles React + socket.io-client + react-markdown)
      └── build:server (esbuild — bundles Express/Hono + Socket.IO server + sql.js)
  └── esbuild → dist/index.js
  └── postbuild: copy dashboard/dist → cli/dist/dashboard/
```

### Shared DB Access Layer

The `ocr state` CLI commands and the dashboard server both need to read/write the same SQLite schema. To prevent drift:
- A shared internal module (`packages/shared/persistence/`) contains: schema DDL, migration runner, typed query functions.
- The dashboard server imports this module at build time (or bundles it into `server.js`).
- The CLI uses it directly for `ocr state init|transition|close|sync`.

### npm Publish

- `packages/cli/package.json` includes `"files": ["dist"]` — this captures `dist/dashboard/`
- `sql.js` is a runtime dependency of the CLI (needed for `ocr state` commands and `ocr dashboard`)
- `socket.io` is bundled into `dist/dashboard/server.js` — not a runtime dep of the CLI itself
- `@open-code-review/dashboard` is a devDependency of the CLI (needed at build time only, stripped on publish)
- The dashboard package itself has `"private": true` and is never published

### Development Binary

For local development, AI agents and developers use `./bin/ocr` (a shell wrapper that runs `node packages/cli/dist/index.js "$@"`) instead of the globally-installed `ocr` binary. This ensures agents always run the latest local build, including the `state` command which writes directly to SQLite.

---

## Constraints & Decisions

### C-1: SQLite is the single source of truth for ALL consumers

SQLite is authoritative for the CLI, agents, and dashboard. All three read from and write to the same `.ocr/data/ocr.db` file:
- **Agents** write orchestration state via `ocr state` CLI commands → `sessions` + `orchestration_events` tables.
- **FilesystemSync** writes parsed artifact data → `review_rounds`, `reviewer_outputs`, `review_findings`, `markdown_artifacts`, `map_*` tables.
- **Dashboard** writes user interaction data → `user_*` tables, `command_executions`.
- **CLI** (`ocr progress`) reads from SQLite to render the terminal progress UI.

`state.json` is **deprecated** as the primary state medium. It MAY be written as a backward-compatible side-effect by `ocr state` commands for tools that haven't migrated, but it is NOT read by any first-party consumer in the new architecture.

### C-2: Dashboard does not modify agent artifacts

The dashboard never writes to `.ocr/sessions/` files. It only writes to the SQLite database (`.ocr/data/ocr.db`). This means AI agent workflows are never disrupted by dashboard activity.

### C-3: The DB must be auto-created

If `.ocr/data/ocr.db` does not exist, it must be created automatically by whichever process needs it first — whether that's `ocr state init`, `ocr state sync`, or `ocr dashboard`. The creation includes running the full schema migration. No manual setup step is required.

### C-4: Mermaid is lazy-loaded

The Mermaid library (~2MB) is loaded only when a user navigates to a map run page that has a dependency graph. It is not included in the initial client bundle.

### C-5: Socket.IO for all real-time communication

All real-time updates between server and client use Socket.IO. **No HTTP polling.** This provides:
- Sub-second update latency (vs. 3-second polling intervals)
- Efficient resource usage (no wasted requests when nothing has changed)
- Bi-directional communication (required for command execution streaming)
- Room-based scoping (clients only receive events for the session they're viewing)
- Automatic reconnection with exponential backoff

### C-6: Monorepo-aware dev server

The dashboard dev server (`dev.ts`) must resolve the `.ocr/` directory by walking up from `process.cwd()` to find the nearest `.ocr/` directory — similar to how git resolves `.git/`. This is necessary because Nx sets `cwd` to `packages/dashboard/` for the dev target, but `.ocr/` lives at the monorepo root.

### C-7: Markdown content is stored in SQLite

Raw markdown content for all artifacts (reviewer outputs, final reviews, discourse, maps, flow analysis, etc.) is stored in SQLite (`markdown_artifacts` table and `reviewer_outputs.markdown_content`). This means:
- The dashboard never needs to read files from the filesystem directly — all rendering is from DB content.
- The API can serve markdown content without filesystem access, improving testability and portability.
- Full-text search across artifacts becomes feasible in future versions.

### C-8: Command execution is sandboxed

CLI commands executed from the dashboard (FR-11) run as child processes of the dashboard server. They:
- Execute in the project root directory (same CWD as the dashboard server)
- Are limited to a whitelist of OCR commands (no arbitrary shell execution)
- Have their output captured and streamed via Socket.IO
- Are logged to `command_executions` table for audit

---

## Parsing Specifications

### Map Section Parsing (from `map.md`)

Sections are identified by `### Section {n}: {Title}` headings. File tables follow the format:

```markdown
| Done | File | Role |
|:----:|------|------|
|  | `path/to/file.ts` | brief role description |
```

The parser must extract:
- Section number and title from heading
- Section description (first paragraph after heading, before table)
- File path (from backtick-wrapped cell in File column)
- Role (from Role column)
- Flow summary (from `**Flow**: ...` line)

The "Unrelated Changes" section uses section_number = 0.

Additionally, the **full raw markdown** is stored in `markdown_artifacts` for rendering via FR-12.

### Review Finding Parsing (from `reviews/{type}-{n}.md`)

Findings are identified by `## Finding` / `## Issue` / `## Suggestion` level-2 headings. The parser must extract:
- Title (heading text after the prefix)
- Severity (from `**Severity**:` or `**Type**:` field)
- File path and line range (from `**Location**:` or `**File**:` field)
- Issue summary (first paragraph of finding body)
- Suggestion text (from `**Suggested fix**:` or `**Fix**:` section)
- Blocker status (from `**Blocker**:` field or section in final.md)

Additionally, the **full raw markdown** is stored in `reviewer_outputs.markdown_content` for rendering.

### Final Review Parsing (from `final.md`)

The parser must extract:
- Verdict (from `**APPROVE**` / `**REQUEST CHANGES**` / `**NEEDS DISCUSSION**`)
- Blocker count (count of `### Blocker` headings or items in Blockers section)
- Suggestion count (count of items in Suggestions section)

Additionally, the **full raw markdown** is stored in `markdown_artifacts` for rendering.

### Flow Analysis Parsing (from `flow-analysis.md`)

The parser generates Mermaid graph definition strings. It must:
- Identify section-to-section dependencies (e.g., "Section 1 types are imported by Section 2 services")
- Identify file-to-file dependencies within sections (e.g., "auth.service.ts imports types.ts")
- Generate valid Mermaid `graph LR` / `graph TD` syntax

This parsing happens on-demand (API request) from the stored markdown content in `markdown_artifacts`. The Mermaid definition is computed, not persisted.

---

## Agent State Machine Audit

This section describes the **required changes** to the `packages/agents/` package and its supporting CLI commands to fully leverage the new SQLite-driven state architecture. This is a critical migration — agents currently rely on `state.json` as the primary state medium and filesystem-derived round/phase information. The new architecture requires agents to write all orchestration state to SQLite via `ocr state` CLI commands, which themselves must be reworked to target the database.

### Current Agent State Model (to be migrated)

Today, the agent orchestration state machine works as follows:

1. **`state.json` is the primary state file** — Written directly by agents at every phase transition. Contains `session_id`, `workflow_type`, `status`, `current_phase`, `phase_number`, `current_round`, `current_map_run`, timestamps.
2. **Filesystem is truth for round/artifact data** — Round count derived from `rounds/round-*/` directory enumeration. Round completion derived from `final.md` existence. Reviewers derived from file listing.
3. **CLI `ocr progress` reads `state.json` + filesystem** — Implements its own reconciliation logic, trusting filesystem for round data and `state.json` for phase state.
4. **No event log** — Phase transitions are destructive overwrites of `state.json`. There's no history of when phases started/completed, making timeline reconstruction impossible.

### Target Agent State Model (new architecture)

1. **SQLite `sessions` table is the primary state store** — `ocr state` CLI commands write directly to the `sessions` table. Agents call `ocr state init|transition|close` exactly as before, but the CLI writes to SQLite instead of (or in addition to) `state.json`.
2. **`orchestration_events` table provides immutable event history** — Every `ocr state` call also inserts a row into `orchestration_events`. This enables the dashboard phase timeline, debugging, and audit trails.
3. **Filesystem remains the artifact delivery mechanism** — Agents continue to write markdown files to `.ocr/sessions/`. FilesystemSync parses these into the artifact layer of SQLite. Agents do NOT need to change how they write markdown artifacts.
4. **`state.json` becomes a backward-compatible side-effect** — `ocr state` commands MAY still write `state.json` for tools that haven't migrated, but it is no longer the source of truth.

### Required Changes to `ocr state` CLI Commands

The `ocr state` subcommands must be reworked to target SQLite. These are the commands that agents call during workflow execution:

#### `ocr state init`

**Current behavior**: Creates `state.json` with initial session state.

**New behavior**:
1. Open/create `.ocr/data/ocr.db` (auto-create with migrations if missing)
2. `INSERT INTO sessions (...)` with initial state (phase=context, status=active, etc.)
3. `INSERT INTO orchestration_events (...)` with `event_type='session_created'`
4. **(Backward compat)**: Write `state.json` as side-effect
5. Return session ID to stdout (agents parse this)

#### `ocr state transition`

**Current behavior**: Overwrites `state.json` with new phase/round state.

**New behavior**:
1. Open `.ocr/data/ocr.db`
2. `UPDATE sessions SET current_phase=?, phase_number=?, updated_at=? WHERE id=?`
3. `INSERT INTO orchestration_events (...)` with `event_type='phase_transition'`
4. If round change: `INSERT INTO orchestration_events (...)` with `event_type='round_started'`
5. **(Backward compat)**: Write `state.json` as side-effect
6. If the dashboard server is running, it detects the SQLite write and emits Socket.IO events

#### `ocr state close`

**Current behavior**: Sets `status: "closed"` in `state.json`.

**New behavior**:
1. `UPDATE sessions SET status='closed', current_phase='complete', updated_at=? WHERE id=?`
2. `INSERT INTO orchestration_events (...)` with `event_type='session_closed'`
3. **(Backward compat)**: Write `state.json` as side-effect

#### `ocr state show`

**Current behavior**: Reads `state.json` and prints it.

**New behavior**: `SELECT * FROM sessions WHERE id=?` + recent events from `orchestration_events`.

#### `ocr state sync`

**Current behavior**: Syncs filesystem artifacts to SQLite.

**New behavior**: Triggers the same FilesystemSync logic used by the dashboard server. Scans `.ocr/sessions/` and upserts artifact data into SQLite. Also backfills any `sessions` rows that exist on the filesystem but not in the DB (legacy migration).

### Required Changes to Agent Reference Files

The following files in `packages/agents/skills/ocr/references/` must be updated to reflect the new state model:

#### `references/session-state.md`

- Replace all references to "write to `state.json`" with "call `ocr state` CLI command"
- Remove instructions for agents to directly construct/write JSON to `state.json`
- Add instructions for agents to call `./bin/ocr state transition --session {id} --phase {phase} --phase-number {n}` at each phase boundary
- Remove filesystem-derived state explanations (round count from directory enumeration) — this is now handled by SQL queries
- Add documentation for the `orchestration_events` event log and how the dashboard uses it
- Clarify that `state.json` is a backward-compatible side-effect, not the source of truth

#### `references/workflow.md` (Review workflow)

- **Phase 0 (Session State Verification)**: Update to query SQLite via `ocr state show` instead of reading `state.json` directly
- **State Tracking section**: Replace JSON examples with `ocr state` CLI call examples
- **All phase transitions**: Replace "write to `state.json`" instructions with `./bin/ocr state transition` calls
- **Phase 8 (Present)**: Replace "update `state.json` with `status: closed`" with `./bin/ocr state close`
- **Round Resolution Algorithm**: Replace bash directory enumeration with `ocr state show --rounds` or equivalent DB query

#### `references/map-workflow.md` (Map workflow)

- Same changes as `workflow.md` — replace all `state.json` writes with `ocr state` CLI calls
- **Phase 0 (Session State Verification)**: Use `ocr state show` to check existing state
- **State Tracking section**: Replace JSON write examples with `ocr state transition --workflow-type map --phase {phase}` calls
- **Map run resolution**: Use DB query to determine current run number instead of directory enumeration

#### `commands/review.md` and `commands/map.md`

- Update "Session State Check" sections to use `ocr state show` instead of `ls` + `cat state.json`
- Update "Determine action" logic to query SQLite state instead of comparing `state.json` with filesystem

### Migration Path

The migration from `state.json`-driven to SQLite-driven agents should be **backward compatible**:

1. **Phase 1 — Dual write**: `ocr state` commands write to both SQLite and `state.json`. Agents continue calling the same CLI commands. `ocr progress` reads from SQLite (with `state.json` fallback).
2. **Phase 2 — Agent reference updates**: Update agent reference files to document the new model. Agents that follow the updated references will naturally use the new commands.
3. **Phase 3 — Deprecate `state.json` reads**: Remove `state.json` fallback from `ocr progress`. All consumers read from SQLite.
4. **Phase 4 — Remove `state.json` writes**: Stop writing `state.json` entirely. Agents that haven't updated will fail gracefully (the data still exists in SQLite, just not in the file they expect).

### What Does NOT Change for Agents

- **Agents still write markdown files to the filesystem** — `discovered-standards.md`, `context.md`, `reviews/*.md`, `discourse.md`, `final.md`, `map.md`, etc. This is unchanged.
- **Agents still call `./bin/ocr state` commands** — The command interface is the same. Only the underlying implementation changes (writes to SQLite instead of/in addition to `state.json`).
- **Session directory structure is unchanged** — `.ocr/sessions/{YYYY-MM-DD}-{branch}/rounds/round-{n}/reviews/{type}-{n}.md` etc.
- **Checkpoint rules are unchanged** — The same artifact existence checks apply before proceeding to each phase.

---

## Open Questions

These items need resolution before or during implementation:

1. **~~Markdown rendering~~** — **RESOLVED**: All markdown artifacts (discourse, final, reviews, maps) SHALL be rendered as rich markdown in the dashboard using `react-markdown` + `rehype-highlight` + `remark-gfm`. Structured data (findings, verdicts) is shown via native dashboard components alongside the rendered markdown.

2. **Search** — Should the dashboard support searching across findings, files, or sessions? (Recommendation: defer to v2. Filter-based navigation is sufficient for v1. Full-text search over `markdown_artifacts` content is a natural v2 feature given the new schema.)

3. **Export** — Should users be able to export progress data (e.g., "send to GitHub PR")? (Recommendation: defer. The existing `ocr post` CLI command already handles GitHub integration. It can be triggered from the dashboard command palette in v1.)

4. **Multi-user** — If two people open the dashboard simultaneously (same project, same machine), what happens? (Answer: They share the same SQLite DB via WAL mode. Socket.IO broadcasts to all connected clients. Last write wins for user progress. Acceptable for v1 since this is a local tool.)

5. **SQLite WAL detection for change notification** — How does the dashboard server detect when `ocr state` CLI (a separate process) writes to the DB? Options:
   - **Filesystem watch on `.ocr/data/ocr.db-wal`** — chokidar watches the WAL file for changes, triggers a "check for new events" query.
   - **Polling `orchestration_events` table** — Server polls `SELECT MAX(id) FROM orchestration_events` on a short interval (500ms). Lightweight since it's a single integer comparison.
   - **IPC signal** — `ocr state` CLI sends a signal (e.g., writes to a Unix socket or named pipe) when it modifies the DB. Most responsive but more complex.
   - **Recommendation**: Start with WAL file watching (simplest) + polling fallback (most reliable). Optimize to IPC if latency matters.

6. **xterm.js bundle size** — `@xterm/xterm` adds ~200KB gzipped. Should it be lazy-loaded only when the command panel opens, or bundled upfront? (Recommendation: lazy-load via `React.lazy()`, consistent with Mermaid approach.)
