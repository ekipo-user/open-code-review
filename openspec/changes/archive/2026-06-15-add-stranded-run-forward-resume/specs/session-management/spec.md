## ADDED Requirements

### Requirement: Forward-Resume of a Stranded Mid-Pipeline Run

A stranded mid-pipeline run SHALL be forward-resumable from its current phase by an entity that outlives the agent turn. The **stranded-mid-pipeline** signature is a session that is `active`, whose current round has **no** terminal `round_completed` event, and whose owning agent turn has ended — left when the turn ends between phases (e.g. after entering `reviews`, before reaching `complete-round`). This is the missing twin of `Auto-Finalize a Completed-But-Open Session`: that requirement advances a run whose work is *done*; this one advances a run whose work is *unfinished*. It applies to the **review** workflow only; stranded `map` runs are out of scope for this change.

**Forward target — the event-sourced `current_phase`, never a re-derived "validated phase".** The resume target SHALL be the session's `current_phase` as projected from the latest `phase_transition` event (which is emitted at phase *entry*). Forward-resume SHALL re-enter `current_phase` and drive the pipeline forward to `round_completed`; it SHALL NEVER regress `current_phase` to an earlier phase. The system makes **no** event-log claim that a phase's *artifact* is "validated" (the event log records only phase entry and the terminal `round_completed`/`map_completed`); instead, re-running `current_phase` is **idempotent by virtue of the workflow's own phase execution** — e.g. Phase 4 re-spawns only the reviewers whose outputs are not already present. Forward-resume thus reuses already-produced artifacts as a property of the workflow, not as a guarantee derived from the event log.

**Forward-resume continues from `current_phase`; it SHALL NOT re-initialize the round.** Forward-resume continues an *in-progress* round from its `current_phase`. It SHALL NOT go through the `ocr state begin` re-open path, which is reserved for starting the *next* round on a completed session and resets the phase to the workflow's initial phase (`context`); routing a stranded mid-pipeline run through `begin` would regress `current_phase` and is forbidden.

**Single-writer resume lease (the concurrency guard).** Because the resume continuation runs as a long-lived agent turn *outside* any single database transaction, mutual exclusion SHALL be enforced by a **resume lease**, not by inferring it from finalization of an unrelated execution row. The lease is a `session_resumed` event carrying metadata `{kind: "forward_resume"}` (the same event type already used by `begin`'s new-round re-open, *discriminated by metadata* — like `session_auto_closed_stale {reason}` — so no new event type is introduced). The attempt count and the lease predicate SHALL consider only `session_resumed` events whose `kind` is `forward_resume`, never the new-round re-open events. Each forward-resume SHALL, in one transaction, append such a lease event admitted only if ALL hold: (a) there is no live `forward_resume` lease within the lease TTL (`runtime.forward_resume_lease_seconds`); and (b) the count of `forward_resume` leases for the current round is below the cap. The continuation (skill re-invocation or host spawn) SHALL proceed only if this insert wins. Because the lease event is appended *before* the continuation starts, the attempt is counted even if the continuation dies before doing any work.

**The lease event SHALL NOT carry a `phase` or `round` column** (it is a pure annotation), so the projection fold of `session_resumed` — which would otherwise set `current_phase`/`current_round` from the event — leaves the projection unchanged. Equivalently, the projection SHALL ignore `forward_resume`-tagged `session_resumed` for phase/round purposes. This is load-bearing: a lease event that regressed `current_phase` would defeat the forward-only rule via its own bookkeeping.

**Lease lifetime spans the whole continuation, not one hop.** The lease SHALL be held until the continuation emits `round_completed` (success) or the TTL elapses (presumed dead); it SHALL be **renewed** on each `phase_transition` the continuation emits (a heartbeat), NOT released on the first one — otherwise a multi-phase resume (the normal case, e.g. `reviews → aggregation → discourse → synthesis`) would run unprotected after its first transition. `runtime.forward_resume_lease_seconds` SHALL be chosen ≥ the longest expected single-phase duration so a slow-but-alive continuation renews before expiry. Should the TTL nonetheless lapse while a continuation is still alive, a second admitted owner is bounded by the cap and harmless: both continuations are forward-only, reuse present artifacts, and `complete-round` is idempotent (at most one `round_completed` is ever recorded), so a transient double-drive cannot corrupt completion.

**Bounded with an honest non-success terminal.** The attempt count is the number of `forward_resume` lease events for the current round, bounded by `runtime.forward_resume_max_attempts` (default 2). On cap exhaustion the run SHALL be driven to a terminal **non-success close** through the guarded close path using the already-permitted `session_auto_closed_stale` reason event, with metadata recording `{reason: "forward_resume_exhausted", attempts: N}`; its child `agent_sessions` rows are reclassified `orphaned` per `Orphan Reclassification`. This terminal SHALL NEVER be reported as a successful completion (no fabricated `round_completed`) and SHALL NEVER use `session_aborted`. All on-disk artifacts are preserved so a human can start a fresh review that reuses them. (No new `event_type` is introduced; the closed taxonomy and close-guard are unchanged.)

**Two tiers.**
- **Baseline (all hosts, no daemon):** forward-resume is the human re-invoking the review skill. Its Phase 0 reads `ocr state status --json`, observes `next_action = forward_resume`, and continues forward from `current_phase`. This needs **no** vendor resume adapter, **no** captured vendor session id, and **no** death-evidence gate (a human initiating it is the liveness signal). It works identically on all four hosts.
- **Dashboard-enhanced:** the watchdog auto-detects the stranded signature and auto-spawns the host to continue, gated on positive death evidence for the owning turn (a clean parent-execution exit counts as positive death evidence). Auto-spawn uses the per-vendor adapter and is therefore available only on hosts with a resume adapter (Claude Code, OpenCode today); on a host with no adapter the dashboard SHALL surface the "Pick up in terminal" handoff (i.e. the baseline path) rather than auto-spawn.

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

## MODIFIED Requirements

### Requirement: Auto-Finalize a Completed-But-Open Session

A session whose current round/run is provably complete (its `round_completed`/`map_completed` event exists) but whose `status` is still `active` — the wedge signature, left when an agent finishes its round but dies before `ocr state finish` — SHALL be driven to `closed` automatically through the guarded close path, not left open forever. Finalization SHALL be a no-op unless the session is `active`, the completion invariant holds, AND no dependent execution is still in flight, so it is safe to attempt on every execution exit. It SHALL be reachable both per-execution (when a dashboard-spawned execution finalizes) and via a startup/periodic sweep (recovering sessions whose finishing execution ran while no server was up). It SHALL never close an incomplete session and never abort.

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
