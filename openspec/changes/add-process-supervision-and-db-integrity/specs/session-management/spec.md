## ADDED Requirements

### Requirement: Parent Execution Heartbeat

A dashboard-spawned workflow's parent `command_executions` row SHALL have its `last_heartbeat_at` refreshed for the duration of the run — not seeded once at spawn — so liveness reflects the running agent and a long review does not drift to "stalled." The heartbeat SHALL be driven by output activity (throttled) and by a supervisor tick while the process is alive.

#### Scenario: Long review stays fresh

- **GIVEN** a dashboard-spawned review producing output over many minutes
- **WHEN** the command-runner observes stdout activity
- **THEN** it SHALL bump the parent row's `last_heartbeat_at` (throttled to avoid write amplification)
- **AND** the row SHALL NOT be classified "stalled" while the process is healthy

### Requirement: Watchdog Reaping of Wedged Processes

The command-runner SHALL run a per-execution watchdog that terminates a process whose work is done but which will not exit, and one that is alive past a hard deadline — finalizing the row deterministically rather than waiting on stdio EOF.

#### Scenario: Work done but process will not exit

- **GIVEN** the vendor emitted its terminal `result` event for an execution
- **AND** the process is still alive after a grace window
- **THEN** the watchdog SHALL reap the whole process tree and finalize the execution

#### Scenario: Alive past the hard deadline

- **GIVEN** an execution alive beyond the configured hard deadline with no result
- **THEN** the watchdog SHALL reap the tree and finalize with a distinct terminal exit code (`-5`), separate from cancelled (`-2`/`-4`) and orphaned-dead (`-3`)

### Requirement: Finalization Is First-Wins Idempotent

An execution's finalization MAY be triggered by the `result` event, the process `close`, the watchdog, or cancel. Exactly one SHALL take effect; the rest SHALL be no-ops, so a row is never double-finalized or double-emitted.

#### Scenario: Result then close

- **WHEN** an execution is finalized by one trigger and another fires later
- **THEN** the later trigger SHALL not overwrite the recorded exit code or re-emit completion
