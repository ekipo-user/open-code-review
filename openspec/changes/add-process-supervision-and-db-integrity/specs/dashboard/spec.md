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

### Requirement: File-Stdio Process Isolation

A detached workflow agent's stdout and stderr SHALL be redirected to a per-execution log file rather than OS pipes the dashboard holds. This removes the wedge at its root: a leaked grandchild that inherits the agent's file descriptors holds no pipe whose EOF the dashboard waits on, so `proc.on('close')` fires on the *direct* child's exit and finalization can never hang on stdio EOF. The dashboard SHALL stream the live output by tailing that log file through the same parser path used for pipe output, preserving multi-byte UTF-8 codepoints that straddle a read boundary, and SHALL drain the tail on close so no trailing output is lost. The tailer SHALL be released on every finalization path.

#### Scenario: A leaked grandchild cannot hold the output open

- **GIVEN** a detached workflow whose child spawned a daemon that inherits fd 1/2
- **WHEN** the direct agent process exits
- **THEN** the dashboard SHALL observe `close` and finalize, regardless of the still-living daemon

#### Scenario: Tailed output matches pipe output

- **GIVEN** a workflow streaming structured output (including non-ASCII) to its log file
- **WHEN** the dashboard tails the file
- **THEN** the parsed event stream SHALL be byte-equivalent to the pipe path, with no replacement characters at read boundaries
- **AND** the final bytes written just before exit SHALL be drained and parsed
