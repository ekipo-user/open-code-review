## ADDED Requirements

### Requirement: Verdict Badge Renders the Merge Gate with a Subordinate Residual-Work Chip

The round view SHALL render the verdict as a single headline badge representing
the **merge gate** (`APPROVE` / `REQUEST CHANGES` / `NEEDS DISCUSSION`), with
non-blocking residual work surfaced as a **subordinate chip derived at render
time from the per-round counts** (`should_fix_count`, `suggestion_count`) — never
stored in or inferred from the verdict string. The badge and the chip SHALL be
visually distinct so the merge decision is not confused with the amount of
leftover work. The three status axes — round **verdict** (the decision),
round-level **triage** aggregate, and per-**finding** triage — SHALL each use a
distinct visual treatment so they are not mistaken for one another.

#### Scenario: Approve with residual work shows a chip, not a different verdict
- **GIVEN** a round whose verdict is `APPROVE` with `should_fix_count = 2` and `suggestion_count = 3`
- **WHEN** the round view renders
- **THEN** a single `APPROVE` verdict badge SHALL be shown
- **AND** a subordinate residual-work chip SHALL summarize the counts (e.g. "2 follow-ups · 3 suggestions"), with follow-ups visually weighted over suggestions
- **AND** the residual work SHALL NOT alter or replace the `APPROVE` headline

#### Scenario: Clean approve shows no residual chip
- **GIVEN** a round whose verdict is `APPROVE` with zero should-fix and zero suggestion findings
- **WHEN** the round view renders
- **THEN** the `APPROVE` badge SHALL be shown with no residual-work chip (or an explicit "clean" affordance)

#### Scenario: Status axes are visually separated
- **WHEN** a round view shows the verdict, the round-level triage aggregate, and the per-finding triage in the findings table
- **THEN** the verdict SHALL render as one bold headline badge, the round-level triage as a subordinate aggregate, and per-finding triage as per-row indicators
- **AND** the three SHALL be distinguishable at a glance and not share an identical badge style

### Requirement: Verdict Read-Time Normalization

When ingesting orchestrator round metadata, the dashboard SHALL normalize the
verdict through the shared `@open-code-review/platform` `normalizeVerdict`
function before storing and before emitting socket updates, so legacy and
aliased values map to a canonical state. A value that cannot be normalized SHALL
be stored as-is and SHALL render via the neutral graceful-degradation fallback
rather than as a raw, unstyled token.

#### Scenario: Legacy composite verdict normalizes to a canonical state
- **GIVEN** a `round-meta.json` whose `verdict` is a retired/aliased value such as `accept_with_followups`
- **WHEN** FilesystemSync processes it
- **THEN** the stored verdict SHALL be the canonical mapping (`APPROVE`)
- **AND** the round's residual work SHALL continue to be conveyed by its finding counts

#### Scenario: Unknown verdict degrades gracefully
- **WHEN** a verdict value cannot be mapped to any canonical state or alias
- **THEN** the raw value SHALL be stored and the badge SHALL render via the neutral fallback (no crash, no raw "?" as the sole content)

### Requirement: Findings Table Has Loading, Empty, and Degraded States

The findings table SHALL render explicit loading, empty, and degraded states
instead of an indefinite blank region, and its severity sort SHALL be robust to
unrecognized severity values (an unknown severity SHALL sort to a defined
position rather than poisoning the comparison with `NaN`).

#### Scenario: Loading state
- **WHEN** a round's findings have not yet been loaded
- **THEN** the table SHALL show a loading affordance rather than an empty region

#### Scenario: Empty state
- **WHEN** a round has zero findings
- **THEN** the table SHALL show an explicit empty state (e.g. "No findings")

#### Scenario: Unknown severity sorts deterministically
- **GIVEN** a finding whose severity is not one of the recognized values
- **WHEN** findings are sorted by severity
- **THEN** the unknown-severity row SHALL sort to a defined position and the sort SHALL NOT throw or produce a `NaN`-driven nondeterministic order

## MODIFIED Requirements

### Requirement: CLI Command Execution

The dashboard SHALL allow users to execute OCR CLI commands from the browser with real-time output streaming via Socket.IO, SHALL derive a command's reported outcome from the workflow's completeness rather than the process exit code alone, and SHALL mutate workflow lifecycle only by invoking the `ocr state` CLI (never by writing lifecycle tables directly). The dashboard read/sync path SHALL NOT originate terminal workflow completion: the presence of a `final.md` artifact on disk is evidence of the **synthesis** phase only, and terminal completion SHALL be recognized solely from the CLI-produced evidence (a `round_completed` event together with a validated `round-meta.json`).

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

#### Scenario: Final artifact alone does not constitute terminal completion

- **GIVEN** a session directory whose latest round contains a `final.md` but no validated `round-meta.json` and no `round_completed` event
- **WHEN** the dashboard's filesystem-sync reconciler processes it
- **THEN** it SHALL derive the `synthesis` phase, not `complete`
- **AND** it SHALL NOT backfill-close the session (SHALL NOT emit a `session_synced`-or-other reason-event close on the strength of `final.md` presence)
- **AND** the `session_completeness` view SHALL NOT report the session `complete`
- **AND** healing such a legacy round into a completed state SHALL be left to the CLI-side `ocr state reconcile` / migration path, which records its own reconciliation audit event

#### Scenario: Discovered session with a terminal artifact event backfill-closes normally

- **GIVEN** a session discovered on disk whose current round has a `round_completed` event and a validated `round-meta.json`
- **WHEN** the reconciler backfill-closes it
- **THEN** it SHALL close through the CLI-published `commitReasonClose` helper
- **AND** the close SHALL satisfy the completion invariant via the terminal artifact event

#### Scenario: Available commands

- **WHEN** user opens the command palette
- **THEN** at least `ocr init`, `ocr update`, `ocr state sync`, `ocr state status` are available
- **AND** commands that mutate state require a confirmation step

#### Scenario: Concurrent command guard

- **GIVEN** a command is already running
- **WHEN** user attempts to start another command
- **THEN** a warning is shown and the user may wait or cancel the running command
