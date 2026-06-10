## ADDED Requirements

### Requirement: Full Process-Tree Reaping

When the dashboard terminates a spawned workflow (cancel, watchdog, shutdown, or singleton takeover), it SHALL terminate the entire descendant process tree, robust to children that escaped the root's process group via `setsid()` (e.g. a leaked MCP daemon). Detached workflow processes SHALL be `unref`'d so a wedged child never holds the dashboard's event loop open, and finalization SHALL be driven by the vendor `result` event and the watchdog rather than stdio EOF.

#### Scenario: Cancel reaps an escaped daemon

- **GIVEN** a detached review whose child spawned a daemon in its own process group
- **WHEN** the review is cancelled
- **THEN** the dashboard SHALL reap the whole descendant tree (SIGTERM → grace → SIGKILL), including the escaped daemon

### Requirement: Single Dashboard Instance

The dashboard SHALL run as a single instance. On startup, if a prior OCR-dashboard process is alive (identified by its command line, not just a PID file), the new server SHALL reap that prior process's tree and take over, rather than warning and coexisting on an incremented port. A PID that is not positively identified as an OCR dashboard SHALL NOT be reaped.

#### Scenario: Takeover of a prior live server

- **GIVEN** a prior OCR-dashboard process is alive when a new one starts
- **WHEN** the new server initializes
- **THEN** it SHALL reap the prior server's process tree (clearing any review subtree it leaked) and claim the port

#### Scenario: A recycled PID is not reaped

- **GIVEN** the dashboard PID file points at a live process that is not an OCR dashboard
- **THEN** the new server SHALL NOT reap it
