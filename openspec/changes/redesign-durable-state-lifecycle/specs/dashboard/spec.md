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

#### Scenario: Lifecycle mutation goes through the CLI-published commit primitive

- **WHEN** the dashboard's filesystem-sync reconciler needs to change workflow lifecycle (e.g. backfill-close a session it discovered on disk)
- **THEN** it SHALL mutate lifecycle only through the CLI-published `commitReasonClose` helper (a single transactional reason-event-then-status commit) — or, equivalently, a child-process `ocr state` invocation
- **AND** the dashboard SHALL NOT issue ad-hoc `INSERT INTO sessions`, `INSERT INTO orchestration_events`, or `UPDATE sessions SET status` outside that helper
- **AND** the dashboard SHALL write directly only to its owned tables (process-supervision journal and UX state)

#### Scenario: Available commands

- **WHEN** user opens the command palette
- **THEN** at least `ocr init`, `ocr update`, `ocr state sync`, `ocr state status` are available
- **AND** commands that mutate state require a confirmation step

#### Scenario: Concurrent command guard

- **GIVEN** a command is already running
- **WHEN** user attempts to start another command
- **THEN** a warning is shown and the user may wait or cancel the running command

## ADDED Requirements

### Requirement: Process-Supervision Liveness Sweep

The dashboard periodically reclaims `command_executions` rows whose supervised process is genuinely gone, stamping them `orphaned` (`exit_code = -3`). Because the supervision journal is the source of truth for a command's outcome, the sweep SHALL ground the terminal `orphaned` verdict in **actual process liveness**, never in heartbeat age alone — a terminal verdict requires positive evidence that the process is dead. `last_heartbeat_at` age is a non-terminal display hint only.

#### Scenario: A live process is never orphaned

- **GIVEN** an unfinished `command_executions` row whose recorded `pid` is a live process
- **WHEN** the liveness sweep runs, even if `last_heartbeat_at` is older than the threshold
- **THEN** the row SHALL NOT be marked `orphaned` and SHALL retain `finished_at IS NULL`
- **AND** a stale heartbeat SHALL surface only as the non-terminal `stalled` display state

#### Scenario: A dead process is reclaimed

- **GIVEN** an unfinished row whose recorded `pid` is confirmed not alive (the OS reports no such process)
- **WHEN** the liveness sweep runs and the row is within the PID-reuse safety window
- **THEN** the row SHALL be marked `orphaned` (`exit_code = -3`, `finished_at` set, `pid` cleared, a structured note appended)

#### Scenario: No positive evidence of death means no terminal verdict

- **GIVEN** an unfinished row with no recorded `pid` (e.g. a self-reporting `start-instance` reviewer), OR a pid-bearing row whose `started_at` is older than the 24h PID-reuse safety window
- **WHEN** the liveness sweep runs
- **THEN** the row SHALL NOT be orphaned by this sweep — a self-reported stale heartbeat is a liveness hint (the non-terminal `stalled` display state), never positive evidence of death
- **AND** such rows are reclaimed instead by their evidence-bearing owners: the agent's own `ocr session end-instance`, the parent-close cascade (`cascadeTerminateExecutions`, exit `-4`), or the coarse session-level stale sweep

#### Scenario: A real completion always wins, and the sweep is idempotent

- **WHEN** a command finishes normally between the sweep's read and its write
- **THEN** the sweep's orphan stamp SHALL be a compare-and-set guarded on `finished_at IS NULL`, so the genuine exit code is never overwritten
- **AND** a second sweep over an already-reclaimed row SHALL make no further change

#### Scenario: A dead workflow process takes its in-flight dependents with it

- **GIVEN** the row being orphaned is a workflow's supervising/top-level process (it has a `workflow_id` and is not itself a `session-instance` reviewer row)
- **WHEN** the sweep confirms that process dead and orphans it
- **THEN** in the same transaction it SHALL cascade-terminate that workflow's other in-flight `command_executions` rows with exit `-4` (cascade), since the parent's confirmed death is positive evidence its in-process children are gone — so reviewer instances do not linger as `stalled` and the session-level sweep is not wedged by them
- **AND** orphaning a `session-instance` row SHALL NOT cascade (an instance never owns a workflow's lifecycle), so a live sibling instance is never taken down

#### Scenario: The cascade reclaims processes, not the session's resumability (deliberate asymmetry)

- **GIVEN** a supervisor was orphaned and its dependents cascade-closed
- **THEN** the cascade SHALL affect only `command_executions` (process supervision); it SHALL NOT itself close the workflow's `sessions` row
- **AND** the `sessions` row remains `active` so the in-progress round stays resumable (re-running the workflow resumes it; `ocr state finish --abort` abandons it); its lifecycle is reclaimed at the coarse 7-day session-level sweep if neither happens
- **AND** consequently the `session_completeness` view reads `in_flight` / `open_no_artifact` (NOT a terminal state) for the workflow until that reconciliation — the user-observable surface of the deliberate asymmetry
- **AND** the dashboard's sweep log line SHALL report how many rows were cascade-closed

#### Scenario: A recycled PID that reads alive leaves the row in-flight (deliberate false-negative)

- **GIVEN** a supervisor died but the OS recycled its PID onto an unrelated live process within the 24h window
- **WHEN** the sweep probes the PID and finds it alive
- **THEN** the sweep SHALL decline to orphan the row (it cannot prove the original process is dead) — leaning toward leaving an alive-named row in-flight rather than risk a false terminal verdict; the row is reclaimed at the coarse session-level sweep
