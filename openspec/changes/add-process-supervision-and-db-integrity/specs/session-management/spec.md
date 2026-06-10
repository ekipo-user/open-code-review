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

### Requirement: Auto-Finalize a Completed-But-Open Session

A session whose current round/run is provably complete (its `round_completed`/`map_completed` event exists) but whose `status` is still `active` — the wedge signature, left when an agent finishes its round but dies before `ocr state finish` — SHALL be driven to `closed` automatically through the guarded close path, not left open forever. Finalization SHALL be a no-op unless the session is `active`, the completion invariant holds, AND no dependent execution is still in flight, so it is safe to attempt on every execution exit. It SHALL be reachable both per-execution (when a dashboard-spawned execution finalizes) and via a startup/periodic sweep (recovering sessions whose finishing execution ran while no server was up). It SHALL never close an incomplete session and never abort.

#### Scenario: A finished round left active is closed

- **GIVEN** a session that is `active` with a `round_completed` event for its current round and no in-flight executions
- **WHEN** reconciliation runs (per-execution exit or sweep)
- **THEN** the session SHALL be closed through the guarded close path (completion invariant + cascade intact)
- **AND** its `completeness_state` SHALL become `complete`

#### Scenario: An incomplete or busy session is left alone

- **GIVEN** a session that is `active` but whose current round has no terminal artifact event, OR that still has an in-flight dependent execution
- **WHEN** reconciliation runs
- **THEN** it SHALL make no change (no close, no abort)

### Requirement: Finalization Is First-Wins Idempotent

An execution's finalization MAY be triggered by the `result` event, the process `close`, the watchdog, or cancel. Exactly one SHALL take effect; the rest SHALL be no-ops, so a row is never double-finalized or double-emitted.

#### Scenario: Result then close

- **WHEN** an execution is finalized by one trigger and another fires later
- **THEN** the later trigger SHALL not overwrite the recorded exit code or re-emit completion
