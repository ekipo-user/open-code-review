# session-management Specification

## Purpose
Session management governs the lifecycle and storage of all OCR review and map artifacts, from session creation through multi-round reviews and map runs, ensuring consistent directory structure, state tracking, and historical access.
## Requirements
### Requirement: Session Directory Structure

The system SHALL store all review artifacts in a structured session directory with round-based organization.

#### Scenario: Session creation
- **GIVEN** a new review is initiated
- **WHEN** the session begins
- **THEN** the system SHALL create directory `.ocr/sessions/{YYYY-MM-DD}-{branch}/`

#### Scenario: Session ID format
- **GIVEN** a review runs on branch `feat/auth-flow`
- **WHEN** session ID is generated
- **THEN** the ID SHALL be `{YYYY-MM-DD}-feat-auth-flow` (slashes replaced with dashes)

#### Scenario: Session contents with rounds
- **GIVEN** a session directory is created
- **WHEN** review completes
- **THEN** the directory SHALL contain:
  - `state.json` - Session state for progress tracking (REQUIRED)
  - `discovered-standards.md` - Merged project context (shared across rounds)
  - `context.md` - Change summary and intent (shared across rounds)
  - `rounds/round-{n}/` - Round-specific artifacts containing:
    - `reviews/` - Individual reviewer outputs
    - `discourse.md` - Discourse results (if not --quick)
    - `final.md` - Synthesized final review

---

### Requirement: Individual Review Storage

The system SHALL store each reviewer's output in the round-specific reviews subdirectory.

#### Scenario: Review file naming
- **GIVEN** security reviewer runs with redundancy=2 in round 1
- **WHEN** reviews are saved
- **THEN** files SHALL be named:
  - `rounds/round-1/reviews/security-1.md`
  - `rounds/round-1/reviews/security-2.md`

#### Scenario: Review file content
- **GIVEN** a reviewer completes their review
- **WHEN** the output is saved
- **THEN** the file SHALL contain:
  - Reviewer name and run number
  - Summary
  - What was explored
  - Findings with severity and location
  - Positives
  - Questions for discourse

---

### Requirement: Session Gitignore

The system SHALL create a .gitignore to exclude session data by default.

#### Scenario: Gitignore creation
- **GIVEN** `.ocr/` directory is created
- **WHEN** first session runs
- **THEN** the system SHALL create `.ocr/.gitignore` containing `sessions/`

#### Scenario: Optional commit
- **GIVEN** user wants to commit review history
- **WHEN** they remove `.ocr/.gitignore` or modify it
- **THEN** session data MAY be committed to version control

---

### Requirement: Session State Tracking

The system SHALL maintain session lifecycle in SQLite, where the `orchestration_events` log is authoritative and the `sessions` row is a projection derived from it. Lifecycle facts SHALL NOT be written to `sessions` independently of the event that justifies them, and `state.json` SHALL NO LONGER be written.

#### Scenario: State stored in SQLite

- **GIVEN** a new review session begins
- **WHEN** the session is initialized via `ocr state begin`
- **THEN** the system SHALL insert a `session_created` event and the derived `sessions` projection row in one transaction
- **AND** it SHALL NOT write `state.json`

#### Scenario: Projection columns

- **GIVEN** a session is in progress
- **WHEN** the `sessions` projection row is read
- **THEN** it SHALL contain `id`, `branch`, `status`, `workflow_type`, `current_phase`, `phase_number`, `current_round`, `current_map_run`, `started_at`, `updated_at`, and `session_dir`
- **AND** each of these values SHALL be consistent with the session's `orchestration_events`

#### Scenario: Lifecycle is event-derived

- **GIVEN** lifecycle state is needed (phase, status, round)
- **WHEN** a consumer reads it
- **THEN** the value SHALL come from the `sessions` projection, which is maintained transactionally from the event log
- **AND** filesystem-derived state SHALL be used only by reconciliation for legacy rows that predate the event log

#### Scenario: State updates at phase transitions

- **GIVEN** a review progresses through phases
- **WHEN** transitioning to a new phase
- **THEN** the orchestrating agent SHALL call `ocr state advance`, which appends a `phase_transition` event and updates the projection in one transaction BEFORE work on the phase begins
- **AND** no `state.json` side-effect SHALL be written

#### Scenario: CLI progress tracking

- **GIVEN** a session exists in SQLite
- **WHEN** `ocr progress` is invoked
- **THEN** it SHALL read the `sessions` projection for progress display including current round
- **AND** it SHALL display "Waiting for session..." when no session state exists

---

### Requirement: Session History

The system SHALL maintain accessible history of review sessions.

#### Scenario: List sessions
- **GIVEN** multiple sessions exist in `.ocr/sessions/`
- **WHEN** `/ocr:history` is invoked
- **THEN** the system SHALL list sessions sorted by date (newest first)

#### Scenario: Session metadata
- **GIVEN** a session directory exists
- **WHEN** listing sessions
- **THEN** the system SHALL extract metadata from `state.json`:
  - Session ID and branch
  - Current phase and status
  - Start time and last update

---

### Requirement: Session Retrieval

The system SHALL support retrieving and displaying past sessions from the current round.

#### Scenario: View final review
- **GIVEN** user invokes `/ocr:show {session-id}`
- **WHEN** session exists
- **THEN** the system SHALL display contents of `rounds/round-{current_round}/final.md`

#### Scenario: View with discourse
- **GIVEN** user invokes `/ocr:show {session-id} --discourse`
- **WHEN** session has discourse.md in current round
- **THEN** the system SHALL include discourse details from `rounds/round-{current_round}/discourse.md`

#### Scenario: View individual reviews
- **GIVEN** user invokes `/ocr:show {session-id} --reviews`
- **WHEN** session has reviews in current round
- **THEN** the system SHALL include all individual reviewer outputs from `rounds/round-{current_round}/reviews/`

---

### Requirement: Context Preservation

The system SHALL preserve change context for historical reference.

#### Scenario: Save change context
- **GIVEN** review workflow gathers change information
- **WHEN** context is collected
- **THEN** the system SHALL save to `context.md`:
  - Target (staged, commit range, or PR)
  - Branch name
  - Commit information
  - Diff summary

#### Scenario: Preserve discovered standards
- **GIVEN** context discovery finds project files
- **WHEN** context is merged
- **THEN** the system SHALL save merged content to `discovered-standards.md` with source attribution

---

### Requirement: Session Uniqueness

The system SHALL handle multiple reviews on the same day and branch using review rounds.

#### Scenario: Same-day re-review
- **GIVEN** a session `2025-01-26-main` already exists with `rounds/round-1/` complete
- **WHEN** another review runs on main branch on 2025-01-26
- **THEN** the system SHALL:
  - Create `rounds/round-2/` directory in the existing session
  - Update `current_round` to 2 in `state.json`
  - Preserve all `round-1/` artifacts unchanged

#### Scenario: Round history preservation
- **GIVEN** multiple review rounds have been completed
- **WHEN** a new round starts
- **THEN** previous round artifacts SHALL remain unchanged and accessible

---

### Requirement: Round-Specific Artifacts

The system SHALL store discourse and synthesis outputs inside round directories, not at session root.

#### Scenario: Discourse output location
- **GIVEN** discourse phase completes for round 2
- **WHEN** discourse results are saved
- **THEN** the file SHALL be saved to `rounds/round-2/discourse.md`

#### Scenario: Final review output location
- **GIVEN** synthesis phase completes for round 2
- **WHEN** final review is saved
- **THEN** the file SHALL be saved to `rounds/round-2/final.md`

#### Scenario: Round metadata output location
- **GIVEN** the synthesis phase completes for round 1
- **WHEN** the orchestrator supplies structured round data to `ocr state complete-round` (via `--stdin` or `--file`)
- **THEN** the CLI SHALL write `rounds/round-1/round-meta.json` with validated structured review data
- **AND** the write SHALL occur regardless of which input source carried the payload, so a successful completion never leaves the round directory without its metadata artifact

#### Scenario: Shared context remains at root
- **GIVEN** a multi-round session exists
- **WHEN** context is examined
- **THEN** `discovered-standards.md`, `requirements.md`, and `context.md` SHALL remain at session root (shared across all rounds)

### Requirement: State Reconciliation

The system SHALL treat the SQLite event log as authoritative and SHALL reconcile legacy or drifted state by deriving truth from events and filesystem artifacts, healing the projection automatically.

#### Scenario: Event log is authoritative

- **GIVEN** a session exists in SQLite
- **WHEN** any consumer needs lifecycle state
- **THEN** the system SHALL derive it from the event log via the `sessions` projection
- **AND** filesystem artifacts SHALL be parsed into content tables but SHALL NOT override lifecycle

#### Scenario: Legacy row without events is reconciled

- **GIVEN** a legacy `sessions` row or session directory lacking lifecycle events
- **WHEN** reconciliation runs (during migration or via `ocr state reconcile`)
- **THEN** it SHALL synthesize completion events from provable artifacts (e.g. a present `final.md`)
- **AND** where completion cannot be proven, it SHALL emit a `session_legacy_import` reason event rather than fabricate completion

#### Scenario: Stale active legacy session is auto-closed

- **GIVEN** a legacy session left `active` with no recent events and no in-flight dependents
- **WHEN** reconciliation or the periodic sweep runs
- **THEN** it SHALL close the session with a `session_auto_closed_stale` event

#### Scenario: Empty round directory does not alter lifecycle

- **GIVEN** a user manually creates `rounds/round-2/` with no contents
- **WHEN** FilesystemSync runs
- **THEN** content tables MAY record the empty round
- **AND** the `sessions` lifecycle projection SHALL NOT be modified (only `ocr state` commands change lifecycle)

### Requirement: Human Review Draft Storage

The system SHALL store AI-generated human-voice review drafts alongside the review round artifacts.

#### Scenario: Draft file location

- **GIVEN** a human review is generated for round 2
- **WHEN** the user saves the draft
- **THEN** it is stored as `rounds/round-2/final-human.md`

#### Scenario: Draft artifact parsing

- **GIVEN** `final-human.md` exists in a round directory
- **WHEN** FilesystemSync processes it
- **THEN** it is stored as a `final-human` artifact type in the `markdown_artifacts` table

#### Scenario: Draft preservation

- **GIVEN** a human review draft exists
- **WHEN** subsequent reviews or syncs run
- **THEN** the draft file is preserved unchanged

### Requirement: Map Artifact Storage

The system SHALL store review map artifacts in a dedicated subdirectory within the session directory, organized by runs.

#### Scenario: Map directory structure
- **GIVEN** a review map is initiated
- **WHEN** the map workflow begins
- **THEN** the system SHALL create `.ocr/sessions/{id}/map/runs/run-{n}/` directory

#### Scenario: Map run contents
- **GIVEN** a review map workflow completes
- **WHEN** artifacts are saved
- **THEN** the `map/runs/run-{n}/` directory SHALL contain:
  - `map-meta.json` — Structured map data (written by CLI via `ocr state map-complete --stdin`)
  - `map.md` — Final rendered review map (presentation artifact, written by orchestrator)

#### Scenario: Map coexistence with reviews
- **GIVEN** a session has both map and review artifacts
- **WHEN** artifacts are stored
- **THEN** they SHALL coexist independently:
  - `map/runs/` for review map runs
  - `rounds/` for code review rounds
  - Shared: `discovered-standards.md`, `context.md`, `requirements.md`

#### Scenario: Multiple map runs
- **GIVEN** a map already exists at `map/runs/run-1/`
- **WHEN** user runs `/ocr:map` again on the same session
- **THEN** the system SHALL:
  - Create `map/runs/run-2/` directory
  - Update `current_map_run` to 2 in SQLite
  - Preserve all `run-1/` artifacts unchanged

#### Scenario: Map run history preservation
- **GIVEN** multiple map runs have been completed
- **WHEN** a new run starts
- **THEN** previous run artifacts SHALL remain unchanged and accessible

---

### Requirement: Map State Tracking

The system SHALL track map generation state in `state.json` using dedicated phase values.

#### Scenario: Map phase values
- **GIVEN** a map workflow is in progress
- **WHEN** `state.json` is updated
- **THEN** `current_phase` SHALL use map-specific values:
  - `map-context` — Context discovery for map
  - `topology` — Topology analysis phase
  - `flow-analysis` — Flow tracing phase
  - `requirements-mapping` — Requirements mapping phase
  - `synthesis` — Map synthesis phase
  - `complete` — Map generation complete

#### Scenario: Map and review state independence
- **GIVEN** a session has both map and review workflows
- **WHEN** tracking state
- **THEN** the system SHALL support:
  - Running map and review independently
  - Different completion states for map vs review
  - Clear indication of which workflow is active
  - Separate tracking: `current_round` for reviews, `current_map_run` for maps

#### Scenario: Map run tracking in state.json
- **GIVEN** map workflow is in progress
- **WHEN** `state.json` is updated
- **THEN** it SHALL include:
  - `current_map_run` — Current map run number (integer)
  - `map_phase` — Current map workflow phase (string)

---

### Requirement: Map Session Retrieval

The system SHALL support retrieving and displaying past map sessions.

#### Scenario: View current map via show command
- **GIVEN** user invokes `/ocr:show {session-id} --map`
- **WHEN** session has map runs
- **THEN** the system SHALL display contents of `map/runs/run-{current_map_run}/map.md`

#### Scenario: View specific map run
- **GIVEN** user invokes `/ocr:show {session-id} --map --run 1`
- **WHEN** the specified run exists
- **THEN** the system SHALL display contents of `map/runs/run-1/map.md`

#### Scenario: Map in history listing
- **GIVEN** user invokes `/ocr:history`
- **WHEN** sessions are listed
- **THEN** sessions with maps SHALL indicate:
  - Map availability
  - Number of map runs completed

### Requirement: Agent-Session Heartbeat Liveness

The system SHALL determine the liveness of an agent-CLI process by the freshness of its heartbeat, recorded against its `agent_sessions` row, with no reliance on direct process inspection or stdout snooping.

#### Scenario: Heartbeat threshold default

- **GIVEN** the user has not configured `runtime.agent_heartbeat_seconds` in `.ocr/config.yaml`
- **WHEN** the system evaluates an `agent_sessions` row's liveness
- **THEN** the threshold SHALL default to 60 seconds

#### Scenario: Heartbeat threshold is configurable

- **GIVEN** the user sets `runtime.agent_heartbeat_seconds: 120` in `.ocr/config.yaml`
- **WHEN** the system evaluates liveness
- **THEN** the threshold SHALL be 120 seconds

#### Scenario: Live session is one with a fresh heartbeat

- **GIVEN** an `agent_sessions` row has `status = 'running'` and `last_heartbeat_at` within the threshold
- **WHEN** liveness is evaluated
- **THEN** the row SHALL be considered live
- **AND** the dashboard SHALL display the parent workflow as Running

#### Scenario: Stale session is detectable before sweep

- **GIVEN** an `agent_sessions` row has `status = 'running'` and `last_heartbeat_at` older than the threshold
- **WHEN** liveness is evaluated *before* the next sweep runs
- **THEN** the row SHALL be classified as Stalled in the dashboard
- **AND** the workflow SHALL surface a "Continue" or "Mark abandoned" affordance

---

### Requirement: Liveness Sweep Trigger Points

The system SHALL run the agent-session liveness sweep at exactly two trigger points and SHALL NOT rely on a background timer.

#### Scenario: Sweep runs on dashboard startup

- **GIVEN** the dashboard process is starting
- **WHEN** initialization reaches the database-readiness step
- **THEN** the system SHALL execute the sweep before accepting client connections

#### Scenario: Sweep runs on agent-session creation

- **GIVEN** the AI invokes `ocr session start-instance` to journal a new agent process
- **WHEN** the new row is inserted
- **THEN** the system SHALL also run the sweep within the same transaction or immediately afterward
- **AND** any prior stale `running` rows for the same workflow SHALL be reclassified

#### Scenario: No background timer

- **GIVEN** the dashboard has been running for an extended period with no new agent sessions
- **WHEN** stale rows accumulate
- **THEN** the system SHALL NOT execute a recurring background sweep
- **AND** stale rows SHALL be reconciled on the next dashboard restart or new agent-session creation

---

### Requirement: Orphan Reclassification

The system SHALL reclassify stale `agent_sessions` rows to `orphaned` rather than leaving them in `running`, providing an unambiguous terminal state and a sweep-time record of the reclassification.

#### Scenario: Stale row transitions to orphaned

- **GIVEN** an `agent_sessions` row has `status = 'running'` and `last_heartbeat_at` older than the threshold
- **WHEN** the sweep executes
- **THEN** the row SHALL transition to `status = 'orphaned'`
- **AND** `ended_at` SHALL be set to the sweep timestamp
- **AND** `notes` SHALL include `"orphaned by liveness sweep at <timestamp>"`

#### Scenario: Already-terminal rows are untouched

- **GIVEN** an `agent_sessions` row has `status` in the set `{ done, crashed, cancelled, orphaned }`
- **WHEN** the sweep executes
- **THEN** the row SHALL be untouched

---

### Requirement: Workflow Liveness Derivation

The system SHALL derive the perceived liveness of a workflow `sessions` row from the freshest heartbeat among its child `agent_sessions`, rather than from the workflow row's own `status` field alone.

#### Scenario: Workflow has at least one live agent session

- **GIVEN** a workflow `sessions` row with `status = 'active'` and at least one child `agent_sessions` row in `status = 'running'` with a fresh heartbeat
- **WHEN** the dashboard renders the session
- **THEN** the workflow SHALL be displayed as Running

#### Scenario: Workflow has only stale or terminal agent sessions

- **GIVEN** a workflow `sessions` row with `status = 'active'` and all child `agent_sessions` rows are stale or terminal
- **WHEN** the dashboard renders the session
- **THEN** the workflow SHALL be displayed as Stalled or Orphaned (matching the most recent agent session's classification)
- **AND** affordances for Continue / Mark abandoned SHALL be available

#### Scenario: Workflow has no agent_sessions yet

- **GIVEN** a workflow `sessions` row exists but no `agent_sessions` rows have been created yet
- **WHEN** the dashboard renders the session
- **THEN** the workflow SHALL be displayed using its existing `sessions.status` field, unchanged from current behavior

### Requirement: Single Owner for Session Capture

All code paths that read or write `vendor_session_id` on agent invocations or that link an `agent_invocation` to a `workflow` SHALL delegate to a single `SessionCaptureService` façade. No call site outside the service implementation SHALL execute SQL that mutates `vendor_session_id` or `workflow_id` directly.

#### Scenario: Command-runner records session ids through the service

- **GIVEN** the dashboard's command-runner observes a `session_id` event from an AI CLI's stdout
- **WHEN** the runner needs to bind that vendor session id to its parent execution row
- **THEN** the runner SHALL call `sessionCapture.recordSessionId(executionId, vendorSessionId)`
- **AND** the runner SHALL NOT execute a direct UPDATE on `command_executions.vendor_session_id`

#### Scenario: state init links workflow_id through the service

- **GIVEN** the AI calls `ocr state init` with `OCR_DASHBOARD_EXECUTION_UID` set in the environment
- **WHEN** the new session row is created
- **THEN** the state init command SHALL call `sessionCapture.linkInvocationToWorkflow(uid, sessionId)`
- **AND** the state init command SHALL NOT execute a direct UPDATE on `command_executions.workflow_id`

#### Scenario: Handoff route resolves resume context through the service

- **GIVEN** a request to `GET /api/sessions/:id/handoff`
- **WHEN** the route builds its response payload
- **THEN** the route SHALL call `sessionCapture.resolveResumeContext(workflowId)` and return its outcome
- **AND** the route SHALL NOT execute SELECTs against `command_executions` to determine resume state

#### Scenario: Service idempotency

- **GIVEN** a `session_id` event arrives multiple times for the same execution row (vendors emit it on every stream message)
- **WHEN** `sessionCapture.recordSessionId(executionId, vendorSessionId)` is called repeatedly
- **THEN** only the first vendor session id SHALL be persisted (subsequent calls SHALL be no-ops via `COALESCE` semantics)
- **AND** `last_heartbeat_at` SHALL be refreshed on the first capture (idempotent same-id repeats and drift events are no-ops and SHALL NOT refresh — drift is an anomaly signal, refreshing would conflate with normal liveness)

#### Scenario: Service interface stability across future refactors

- **GIVEN** future architectural phases (event sourcing, domain table split, storage upgrade) refactor the service's internals
- **WHEN** internal SQL or storage changes
- **THEN** the public method signatures (`recordSessionId`, `linkInvocationToWorkflow`, `resolveResumeContext`) SHALL remain stable
- **AND** call sites in command-runner, state.ts, and the handoff route SHALL NOT require coordinated updates
- **AND** internal linkage-discovery strategies (server-side fallbacks for cross-process uid propagation — currently `autoLinkPendingDashboardExecution` and `linkExecutionToActiveSession`) MAY evolve without spec amendment; only the three contract methods above are externally-stable

---

### Requirement: Events JSONL Replay as Recovery Primitive

When the relational state is incomplete but the per-execution events JSONL on disk contains a captured `session_id` event for the workflow, the `SessionCaptureService` SHALL backfill the relational state from the JSONL and return a resumable outcome. The events file SHALL be load-bearing for resume recovery.

#### Scenario: Recovery from a missed binding

- **GIVEN** an `agent_invocations` row whose `vendor_session_id` is NULL
- **AND** the events JSONL at `.ocr/data/events/<execution_id>.jsonl` contains at least one `session_id` event for that invocation
- **WHEN** `sessionCapture.resolveResumeContext(workflowId)` is called for a workflow containing that invocation
- **THEN** the service SHALL read the JSONL, extract the captured `session_id`, persist it to the row idempotently
- **AND** the service SHALL return `{ kind: 'resumable', ... }` with the recovered vendor session id

#### Scenario: No JSONL means no recovery

- **GIVEN** an `agent_invocations` row whose `vendor_session_id` is NULL
- **AND** no events JSONL exists for that invocation OR the JSONL contains no `session_id` events
- **WHEN** the service attempts recovery
- **THEN** the service SHALL return `{ kind: 'unresumable', reason: 'no-session-id-captured', ... }`

#### Scenario: Recovery never overwrites bound state

- **GIVEN** an `agent_invocations` row whose `vendor_session_id` is already set
- **WHEN** the service is asked to resolve a resume context
- **THEN** the service SHALL use the persisted value
- **AND** the service SHALL NOT consult the JSONL replay path for that row

#### Scenario: Recovery is best-effort, not load-bearing for binding correctness

- **GIVEN** the events JSONL is corrupt, missing, or unreadable
- **WHEN** the service attempts recovery
- **THEN** the service SHALL log a warning and treat the row as unrecoverable
- **AND** the service SHALL return `{ kind: 'unresumable', reason: 'no-session-id-captured', ... }` with diagnostics noting the recovery attempt failed
- **AND** the service SHALL NOT throw or otherwise fail the request

---

### Requirement: Vendor-Agnostic Session Capture Contract

The `SessionCaptureService` and the underlying agent vendor adapters SHALL maintain a vendor-agnostic capture contract: every supported vendor adapter SHALL emit `session_id` events through the normalized event stream; the service SHALL persist them through one code path; vendor-specific resume command construction SHALL be encapsulated in adapter-owned helpers.

#### Scenario: Both vendors emit session_id events

- **GIVEN** an AI process spawned via the Claude Code adapter OR the OpenCode adapter
- **WHEN** the vendor's stdout includes a session id (Claude's top-level `session_id`, OpenCode's top-level `sessionID`)
- **THEN** the adapter SHALL emit a `NormalizedEvent` of `{ type: 'session_id', id: <string> }`
- **AND** the service SHALL persist it through the same `recordSessionId()` call regardless of vendor

#### Scenario: Vendor-native resume commands are adapter-owned

- **GIVEN** the service needs to construct the vendor-native resume command for a captured session id
- **WHEN** building the resume context
- **THEN** the service SHALL delegate to a vendor adapter helper (e.g. `buildVendorResumeCommand(vendor, sessionId)`)
- **AND** the service SHALL NOT contain `if vendor === 'claude'` style switches

#### Scenario: New vendors integrate without service-level changes

- **GIVEN** a new agent vendor (e.g. `gemini-cli`) is added with a conformant adapter that emits `session_id` events through the normalized stream
- **WHEN** a workflow runs against the new vendor
- **THEN** the service SHALL capture and persist its session id without modification
- **AND** the resume context SHALL be constructed from the new vendor's adapter-owned command builder

### Requirement: Atomic Round Completion Lifecycle

Completing a review round SHALL be a single atomic operation that finalizes all of its facts together, so a round can never be left partially completed.

#### Scenario: All-or-nothing completion

- **WHEN** a round is completed via `ocr state complete-round`
- **THEN** the round metadata, the `round_completed` event, the `current_round` advance, and the transition to the `complete` phase SHALL commit together in one transaction
- **AND** a failure at any step SHALL leave the session exactly as it was before the call

#### Scenario: Completion requires the workflow path was walked

- **GIVEN** a review session that has not reached the `synthesis` phase
- **WHEN** `ocr state complete-round` is invoked
- **THEN** the command SHALL refuse with the invariant-unmet code
- **AND** because reaching `synthesis` requires legal graph transitions through analysis, reviews, aggregation, and discourse, a completed round implies the workflow path was actually walked

#### Scenario: Round completion is the single-writer safety boundary

- **GIVEN** two forward-resume continuations both running the same round's remaining phases (e.g. after a lease TTL lapsed while the first was still alive)
- **WHEN** both reach `complete-round` and attempt to commit
- **THEN** exactly one SHALL succeed and exactly one `round_completed` event SHALL be recorded
- **AND** the second SHALL take the safe no-op / self-heal path of `Re-running complete-round is a safe no-op or self-heals the artifact` — so the forward-resume lease is a throttle, while `complete-round`'s idempotency is the actual correctness boundary

---

### Requirement: Invariant-Checked Session Finish

A session SHALL NOT be marked closed-as-complete unless its current round/run is genuinely complete; abandonment SHALL be recorded as a distinct, non-success terminal state.

#### Scenario: Finish blocked on incomplete round

- **GIVEN** a session whose current round has no `round_completed` event
- **WHEN** `ocr state finish` runs without `--abort`
- **THEN** the session SHALL remain open and the command SHALL report the unmet obligation

#### Scenario: Abort is a recorded, non-success terminal

- **WHEN** `ocr state finish --abort` runs
- **THEN** the session SHALL close with a `session_aborted` event
- **AND** no consumer SHALL report the aborted session as a successful completion

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

#### Scenario: Work done but the process already exited (close withheld)

- **GIVEN** the vendor emitted its terminal `result` event and the child process has exited, but `close` is withheld (e.g. a leaked grandchild holds an inherited pipe in pipe-fallback mode)
- **WHEN** the grace window passes
- **THEN** the watchdog SHALL finalize the execution with the result's true verdict WITHOUT reaping (the PID may be recycled; escaped descendants have reparented and are unreachable)
- **AND** the watchdog SHALL NOT refresh the heartbeat of an exited child, so a no-result dead child remains claimable by the liveness sweep

#### Scenario: Sentinel-less hosts are exempt from result-driven finalization (capability-gated)

- **GIVEN** a workflow on a host whose adapter advertises that it emits no terminal sentinel (an adapter capability, e.g. `emitsTerminalSentinel: false` — OpenCode is the current such host: its `step_finish` is per-step, not an end-of-run `result`)
- **THEN** finalization SHALL be driven by the file-stdio'd process `close` and the hard deadline, NOT a `result` event (mapping a per-step event to `result` would arm the grace reap against healthy agents)
- **AND** the exemption SHALL key off the adapter capability, not a host name — any future sentinel-less host inherits it, and a host that later adds an end-of-run event drops it by flipping the capability

#### Scenario: Alive past the hard deadline

- **GIVEN** an execution alive beyond the configured hard deadline with no result
- **THEN** the watchdog SHALL reap the tree and finalize with a distinct terminal exit code (`-5`), separate from cancelled (`-2`/`-4`) and orphaned-dead (`-3`)

### Requirement: Auto-Finalize a Completed-But-Open Session

A wedged session whose current round/run is provably complete (its `round_completed`/`map_completed` event exists) but whose `status` is still `active` — left when an agent finishes its round but dies before `ocr state finish` — SHALL be driven to `closed` automatically through the guarded close path, not left open forever.

**Terminology (the two `active`-strand signatures).** A **wedged session** is `active` with its work *done* — a `round_completed`/`map_completed` event exists but the close was missed; it is handled by this requirement. A **stranded session** is `active` with its work *unfinished* — no terminal artifact event and the owning turn is dead mid-pipeline; it is handled by `Forward-Resume of a Stranded Mid-Pipeline Run`. These two are disjoint and exhaustive over `active` strandings. (The `dashboard` and `sqlite-state` specs use these same two terms.) Finalization SHALL be a no-op unless the session is `active`, the completion invariant holds, AND no dependent execution is still in flight, so it is safe to attempt on every execution exit. It SHALL be reachable both per-execution (when a dashboard-spawned execution finalizes) and via a startup/periodic sweep (recovering sessions whose finishing execution ran while no server was up). It SHALL NOT close an incomplete session and never abort.

This requirement handles ONLY the *artifact-present* stranding (work done, close missed). The disjoint *artifact-absent but resumable* stranding (work unfinished, turn dead mid-pipeline) is delegated to `Forward-Resume of a Stranded Mid-Pipeline Run`. Together the two are exhaustive over `active` strandings: a run with a terminal artifact event is auto-finalized; a run without one is forward-resumed (or, on cap exhaustion, closed non-success). To avoid racing a forward-resume continuation that is about to emit `round_completed`, Auto-Finalize SHALL NOT close a session while a live resume lease (an unreleased `forward_resume` lease within the lease TTL) exists for it, even if a `round_completed` event has just appeared — it defers until the lease is released.

#### Scenario: A finished round left active is closed

- **GIVEN** a session that is `active` with a `round_completed` event for its current round and no in-flight executions
- **WHEN** reconciliation runs (per-execution exit or sweep)
- **THEN** the session SHALL be closed through the guarded close path (completion invariant + cascade intact)
- **AND** its `completeness_state` SHALL become `complete`

#### Scenario: An incomplete or busy session is left alone

- **GIVEN** a session that is `active` but whose current round has no terminal artifact event, OR that still has an in-flight dependent execution
- **WHEN** reconciliation runs
- **THEN** it SHALL make no change (no close, no abort)

#### Scenario: An incomplete, dead, mid-pipeline session is delegated to forward-resume

- **GIVEN** a session that is `active`, whose current round has NO terminal artifact event, with no in-flight dependent execution and positive death evidence on the owning turn
- **WHEN** reconciliation runs
- **THEN** auto-finalize SHALL make no change (it never closes an incomplete session)
- **AND** the run SHALL be eligible for `Forward-Resume of a Stranded Mid-Pipeline Run` rather than left inert

#### Scenario: Auto-Finalize defers to a live resume lease

- **GIVEN** a session with a live resume lease (an unreleased `forward_resume` lease within the lease TTL)
- **WHEN** reconciliation runs, even if a `round_completed` event has just appeared
- **THEN** Auto-Finalize SHALL NOT close the session until the lease is released

### Requirement: Finalization Is First-Wins Idempotent

An execution's finalization MAY be triggered by the `result` event, the process `close`, the watchdog, or cancel. Exactly one SHALL take effect; the rest SHALL be no-ops, so a row is never double-finalized or double-emitted.

#### Scenario: Result then close

- **WHEN** an execution is finalized by one trigger and another fires later
- **THEN** the later trigger SHALL not overwrite the recorded exit code or re-emit completion

### Requirement: Forward-Resume of a Stranded Mid-Pipeline Run

A stranded mid-pipeline run SHALL be forward-resumable from its current phase by an entity that outlives the agent turn. The **stranded session** signature is a session that is `active`, whose current round has **no** terminal `round_completed` event, and whose owning agent turn has ended — left when the turn ends between phases (e.g. after entering `reviews`, before reaching `complete-round`). This is the missing twin of `Auto-Finalize a Completed-But-Open Session`: that requirement advances a run whose work is *done*; this one advances a run whose work is *unfinished*. It applies to the **review** workflow only; stranded `map` runs are out of scope for this change.

**Forward target — the event-sourced `current_phase`, never a re-derived "validated phase".** The resume target SHALL be the session's `current_phase` as projected from the latest `phase_transition` event (which is emitted at phase *entry*). Forward-resume SHALL re-enter `current_phase` and drive the pipeline forward to `round_completed`; it SHALL NOT regress `current_phase` to an earlier phase. The system makes **no** event-log claim that a phase's *artifact* is "validated" (the event log records only phase entry and the terminal `round_completed`/`map_completed`); instead, re-running `current_phase` is **idempotent by virtue of the workflow's own phase execution** — e.g. Phase 4 re-spawns only the reviewers whose outputs are not already present. Forward-resume thus reuses already-produced artifacts as a property of the workflow, not as a guarantee derived from the event log.

**Forward-resume continues from `current_phase`; it SHALL NOT re-initialize the round.** Forward-resume continues an *in-progress* round from its `current_phase`. It SHALL NOT go through the `ocr state begin` re-open path, which is reserved for starting the *next* round on a completed session and resets the phase to the workflow's initial phase (`context`); routing a stranded mid-pipeline run through `begin` would regress `current_phase` and is forbidden.

**Single-writer resume lease (the concurrency guard).** Because the resume continuation runs as a long-lived agent turn *outside* any single database transaction, mutual exclusion SHALL be enforced by a **resume lease**, not by inferring it from finalization of an unrelated execution row. The lease is a `session_resumed` event carrying metadata `{kind: "forward_resume"}` (the same event type already used by `begin`'s new-round re-open, *discriminated by metadata* — like `session_auto_closed_stale {reason}` — so no new event type is introduced). The attempt count and the lease predicate SHALL consider only `session_resumed` events whose `kind` is `forward_resume`, never the new-round re-open events. Each forward-resume SHALL, in one transaction, append such a lease event admitted only if ALL hold: (a) there is no live `forward_resume` lease within the lease TTL (`runtime.forward_resume_lease_seconds`); and (b) the count of `forward_resume` leases for the current round is below the cap. The continuation (skill re-invocation or host spawn) SHALL proceed only if this insert wins. Because the lease event is appended *before* the continuation starts, the attempt is counted even if the continuation dies before doing any work.

**Lease projection invariants (two distinct guards, both required).** These are not equivalent — one is enforced at append, the other at fold — and they cover different attack surfaces:

- **Write-side invariant.** A `forward_resume` lease event SHALL be appended with a NULL `phase`, NULL `phase_number`, and NULL `round` column.
- **Read-side invariant.** Any projection that derives `current_phase`/`phase_number`/`current_round` from `session_resumed` events SHALL discriminate on `metadata.kind` and SHALL treat `kind = forward_resume` as a no-op for phase/round purposes (see `sqlite-state`'s projection-fold requirements).

This is load-bearing: a lease event that moved `current_phase` would defeat the forward-only rule via its own bookkeeping, so neither guard alone is sufficient.

**Lease lifetime spans the whole continuation, not one hop.** The lease SHALL be held until the continuation emits `round_completed` (success) or the TTL elapses (presumed dead); it SHALL be **renewed** on each `phase_transition` the continuation emits (a heartbeat), NOT released on the first one — otherwise a multi-phase resume (the normal case, e.g. `reviews → aggregation → discourse → synthesis`) would run unprotected after its first transition. `runtime.forward_resume_lease_seconds` SHALL be chosen ≥ the longest expected single-phase duration so a slow-but-alive continuation renews before expiry. Should the TTL nonetheless lapse while a continuation is still alive, a second admitted owner is bounded by the cap and harmless: both continuations are forward-only, reuse present artifacts, and `complete-round` is idempotent (at most one `round_completed` is ever recorded), so a transient double-drive cannot corrupt completion.

**Bounded with an honest non-success terminal.** The attempt count is the number of `forward_resume` lease events for the current round, bounded by `runtime.forward_resume_max_attempts` (default 2). On cap exhaustion the run SHALL be driven to a terminal **non-success close** through the guarded close path using the already-permitted `session_auto_closed_stale` reason event, with metadata recording `{reason: "forward_resume_exhausted", attempts: N}`; its child `agent_sessions` rows are reclassified `orphaned` per `Orphan Reclassification`. This terminal SHALL NOT be reported as a successful completion (no fabricated `round_completed`) and SHALL NOT use `session_aborted`. All on-disk artifacts are preserved so a human can start a fresh review that reuses them. (No new `event_type` is introduced; the closed taxonomy and close-guard are unchanged.)

**Who writes the close (no orphaned writer responsibility):** whichever tier detects exhaustion writes it. On the dashboard tier the watchdog writes it; on the baseline (no-daemon) tier the `ocr review --resume` command writes it when it detects the cap is exhausted (see `Resume Flag on Existing Review Command`). A human-only cap exhaustion therefore never leaves the session inert-`active`, preserving the "exhaustive over `active` strandings" guarantee.

**Positive death evidence (canonical definition).** "Positive death evidence" for an owning turn means every journaled `agent_sessions` instance for the workflow is either ended (`finished_at` set) OR has a PID confirmed dead by the shared liveness probe. A stale heartbeat alone SHALL NOT count as death evidence (a live-but-quiet process must never be force-resumed), and a pid-less, unfinished instance therefore does not qualify. A clean parent-execution exit counts. This definition is load-bearing for both tiers and is referenced (not re-defined) by the dashboard watchdog.

**Discriminated-union event metadata.** This requirement introduces the discriminator pattern twice, both over an existing `event_type`'s `metadata` field (no new `event_type`):
- `session_resumed.metadata.kind` — legal values: `forward_resume` (a resume lease). Absent/other = `begin`'s new-round re-open.
- `session_auto_closed_stale.metadata.reason` — legal values include `forward_resume_exhausted` (cap reached) alongside the existing reconcile reasons. The `reason` field is an **open** vocabulary (new reasons MAY be added); consumers SHALL switch on known values and treat unknown reasons as a generic stale close.

**Two tiers.**
- **Baseline (all hosts, no daemon):** forward-resume is the human re-invoking the review skill. Its Phase 0 reads `ocr state status --json`, observes `next_action = forward_resume`, and continues forward from `current_phase`. This needs **no** vendor resume adapter, **no** captured vendor session id, and **no** death-evidence gate (a human initiating it is the liveness signal). It works identically on all four hosts.
- **Dashboard-enhanced:** the watchdog auto-detects the stranded-session signature and auto-spawns the host to continue, gated on positive death evidence for the owning turn (a clean parent-execution exit counts as positive death evidence). Auto-spawn uses the per-vendor adapter and is therefore available only on hosts with a resume adapter (Claude Code, OpenCode today); on a host with no adapter the dashboard SHALL surface the "Pick up in terminal" handoff (i.e. the baseline path) rather than auto-spawn.

#### Scenario: A stranded-at-reviews run is classified forward-resumable

- **GIVEN** an `active` session whose current round has `current_phase = reviews` and no `round_completed` event, whose owning turn has ended
- **WHEN** the stranded-mid-pipeline predicate is evaluated
- **THEN** the run SHALL be classified forward-resumable with `current_phase = reviews` and a non-empty remaining-phase list through `complete`

#### Scenario: Forward-resume re-enters current_phase and never regresses

- **GIVEN** a forward-resumable run with `current_phase = reviews`
- **WHEN** forward-resume runs
- **THEN** it SHALL re-enter `reviews` and drive forward through the remaining phases to `round_completed`
- **AND** it SHALL NOT regress `current_phase` below `reviews`
- **AND** re-running `reviews` SHALL reuse already-present reviewer outputs (the workflow re-spawns only missing reviewers)

#### Scenario: The resume lease admits a single writer under concurrency

- **GIVEN** two forward-resume attempts (e.g. a human re-invocation and a dashboard auto-spawn) racing on the same `active` row
- **WHEN** each tries to append its `forward_resume` lease event
- **THEN** at most one SHALL be admitted (the others fail the lease predicate and do not start a continuation)
- **AND** no two continuations SHALL run the same round's remaining phases concurrently

#### Scenario: An attempt that dies before doing work still consumes the cap

- **GIVEN** a forward-resume whose continuation dies before emitting any `phase_transition`
- **WHEN** the next attempt is considered
- **THEN** the earlier `forward_resume` lease event SHALL still count toward the cap (no uncounted, unbounded retry)

#### Scenario: The lease event does not regress current_phase

- **GIVEN** a forward-resumable run with `current_phase = reviews`
- **WHEN** a `forward_resume` lease event is appended
- **THEN** the projected `current_phase` SHALL remain `reviews` (the lease carries no `phase`/`round` column and the projection ignores `forward_resume`-tagged `session_resumed` for phase/round purposes)

#### Scenario: The lease spans every remaining phase, renewed per transition

- **GIVEN** a forward-resume continuation crossing multiple phases (`reviews → aggregation → discourse → synthesis`)
- **WHEN** it emits each `phase_transition`
- **THEN** the lease SHALL be renewed (not released) and SHALL be held until `round_completed` or TTL expiry
- **AND** no second continuation SHALL be admitted while the lease is live

#### Scenario: Cap exhaustion closes non-success, never as success or abort

- **GIVEN** a run whose current round already has `forward_resume_max_attempts` `forward_resume` lease events without reaching `round_completed`
- **WHEN** another forward-resume is considered
- **THEN** the run SHALL be closed via the guarded path with a `session_auto_closed_stale` reason event carrying `{reason: "forward_resume_exhausted"}`
- **AND** it SHALL NOT be closed as a successful completion and SHALL NOT use `session_aborted`
- **AND** all on-disk artifacts SHALL be preserved

#### Scenario: Baseline forward-resume needs no adapter or token

- **GIVEN** a forward-resumable run on any host with no dashboard daemon running
- **WHEN** the human re-invokes the review skill
- **THEN** Phase 0 SHALL read `next_action = forward_resume` and continue forward from `current_phase`
- **AND** this SHALL require no vendor resume adapter, no captured vendor session id, and no death-evidence gate

#### Scenario: Dashboard auto-resume requires positive death evidence

- **GIVEN** an `active` stranded run and the dashboard daemon running
- **WHEN** the owning turn has positive death evidence (e.g. a clean parent-execution exit) and a resume adapter exists for the host
- **THEN** the watchdog MAY auto-spawn the continuation
- **AND** if the owning turn is still live or lacks positive death evidence, the watchdog SHALL NOT auto-spawn
- **AND** if no resume adapter exists for the host, the dashboard SHALL surface "Pick up in terminal" instead of auto-spawning

