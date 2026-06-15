## ADDED Requirements

### Requirement: DbSyncWatcher Auto-Forward-Resume of Stranded Sessions

In the dashboard-enhanced tier, the `DbSyncWatcher` SHALL detect a stranded mid-pipeline run (per `Forward-Resume of a Stranded Mid-Pipeline Run`) at its existing sweep trigger points and auto-spawn the host to continue, reusing the same `ocr review --resume` primitive a terminal operator would run — the watchdog owns only *triggering* and *bounding*, not a second resume code path. The auto-spawned turn is driven by the fixed CONTROL prompt ("read `ocr state status --json`; act on `next_action`").

Auto-forward-resume SHALL fire only after positive death evidence exists for the owning turn (a clean parent-execution exit counts as positive death evidence; a stale heartbeat alone SHALL NEVER suffice). It SHALL acquire the single-writer resume lease before spawning, SHALL be forward-only (never regressing `current_phase`), and SHALL be bounded by `runtime.forward_resume_max_attempts`; on cap exhaustion it SHALL drive the run to the non-success terminal close (`session_auto_closed_stale` with `{reason: "forward_resume_exhausted"}`) rather than retry. It SHALL never fabricate terminal completion from `final.md` presence. Auto-spawn requires a per-vendor resume adapter; on a host with no adapter the watchdog SHALL NOT auto-spawn and SHALL instead surface the "Pick up in terminal" handoff.

#### Scenario: Watchdog auto-resumes a dead, incomplete, mid-pipeline run

- **GIVEN** an `active` session stranded mid-pipeline with positive death evidence, a host that has a resume adapter, and attempts remaining
- **WHEN** the `DbSyncWatcher` sweep runs (startup or agent-session creation trigger)
- **THEN** it SHALL acquire the resume lease and invoke `ocr review --resume <workflow-session-id>` with the CONTROL prompt
- **AND** the continuation SHALL drive forward from `current_phase`, never regressing it

#### Scenario: Watchdog does not resume a live run

- **GIVEN** an `active` mid-pipeline session with a live `agent_sessions` instance or no positive death evidence
- **WHEN** the sweep runs
- **THEN** the watchdog SHALL NOT acquire a lease or spawn

#### Scenario: Watchdog on a host with no resume adapter hands off to terminal

- **GIVEN** a stranded run on a host with no per-vendor resume adapter
- **WHEN** the sweep runs
- **THEN** the watchdog SHALL NOT auto-spawn
- **AND** the dashboard SHALL surface the "Pick up in terminal" handoff for manual forward-resume

#### Scenario: Watchdog stops at the cap with a non-success close

- **GIVEN** a stranded run that has exhausted `forward_resume_max_attempts`
- **WHEN** the sweep runs
- **THEN** the watchdog SHALL NOT spawn again
- **AND** the run SHALL be closed non-success (`session_auto_closed_stale`, `forward_resume_exhausted`), never as a successful completion

### Requirement: Dashboard Rendering of Forward-Resume and Abort States

The dashboard SHALL render the new `next_action` states honestly and distinctly, so a stranded run never appears either as a fake success or as an inert blank. A `forward_resume` run SHALL render in the session liveness header as a recoverable stall (e.g. "Stalled — resuming" while a lease is live, "Stalled — recoverable" otherwise) with the "Continue here" affordance enabled (or "Pick up in terminal" when no resume adapter exists). An `abort_or_fresh` run SHALL render as a recoverable-failed state with explicit "Start fresh" / "Mark abandoned" affordances rather than a disabled "Continue here" with only a tooltip.

#### Scenario: A forward-resumable run renders as a recoverable stall

- **GIVEN** a session whose derived `next_action` is `forward_resume`
- **WHEN** its detail page is rendered
- **THEN** the liveness header SHALL show a recoverable-stall state (not "Complete", not a verdict badge)
- **AND** "Continue here" SHALL be enabled when a resume adapter exists, else "Pick up in terminal" SHALL be offered

#### Scenario: An abort_or_fresh run offers explicit recovery affordances

- **GIVEN** a session whose derived `next_action` is `abort_or_fresh` (cap exhausted or no legal forward edge)
- **WHEN** its detail page is rendered
- **THEN** the dashboard SHALL offer "Start fresh" and "Mark abandoned" affordances
- **AND** it SHALL NOT present the run as complete or successful

## MODIFIED Requirements

### Requirement: In-Dashboard "Continue Here" Resume

The dashboard SHALL provide a one-click "Continue here" affordance on the session detail page for stalled, orphaned, or completed-but-resumable workflows, that re-spawns the host AI CLI via OCR's resume primitive. The affordance and the automatic watchdog (`DbSyncWatcher Auto-Forward-Resume of Stranded Sessions`) SHALL share the **same** resume primitive and the same fixed CONTROL prompt, and for a stranded mid-pipeline run the resume SHALL be **forward-only** — continuing from `current_phase` rather than regressing it.

#### Scenario: Continue resumes via captured vendor session id

- **GIVEN** a workflow has at least one `agent_sessions` row with `vendor_session_id` populated
- **WHEN** the user clicks "Continue here"
- **THEN** the server SHALL invoke `ocr review --resume <workflow-session-id>` via the existing socket command runner
- **AND** the host CLI SHALL be spawned with its vendor-native resume flag and the captured `vendor_session_id`
- **AND** the vendor session id SHALL NOT be displayed in the UI

#### Scenario: Continue is unavailable when no resume adapter exists

- **GIVEN** a workflow on a host with no per-vendor resume adapter
- **WHEN** the user views the session detail page
- **THEN** the "Continue here" affordance SHALL be disabled with a tooltip explaining that auto-spawn is unavailable for this host
- **AND** the user SHALL be directed to "Pick up in terminal" (re-invoking the review skill), which forward-resumes with no adapter

#### Scenario: Continue forward-resumes a stranded mid-pipeline run

- **GIVEN** a stranded mid-pipeline workflow whose `current_phase` is `reviews` on a host with a resume adapter
- **WHEN** the user clicks "Continue here"
- **THEN** the resume SHALL acquire the lease and continue forward from `reviews` via the shared resume primitive
- **AND** it SHALL NOT regress `current_phase`
