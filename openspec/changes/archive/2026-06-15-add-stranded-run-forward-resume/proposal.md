# Change: Forward-Resume of a Stranded Mid-Pipeline Review

## Why

Review #146 rendered "Incomplete" forever. The session stranded `active@reviews`:
all four reviewer artifacts were present, but no `discourse.md`, no `final.md`,
no verdict, and no `round_completed` event. The orchestrating agent had spawned
its reviewers as background sub-agents, waited on completion notifications, and
the foreground turn **ended** after the reviewer outputs were collected but
before phases 6–8 (discourse → synthesis → present) ran. The run reported
"success" to the host and the session was left checkpointed but unadvanced.

The completion gate did its job: because there was no validated `round-meta.json`
and no `round_completed` event, the dashboard *correctly* refused to call the
round complete (`Atomic State Lifecycle Commands`, `Session Completeness View`).
The honest "Incomplete" is the gate working. **The missing half is recovery:**
nothing drives a stranded *incomplete* mid-pipeline run forward once the agent
turn that owned it is gone.

This is a **vendor-neutral class of bug**, not a Claude Code background-spawn
quirk. Any turn-ending event between phases — a crash, a token limit, a
disconnect, a user `Ctrl-C`, a host that finalizes a turn on its own schedule —
strands the single-long-turn pipeline the same way on every host. The earlier
"forbid `run_in_background`" idea was rejected for exactly this reason: it
couples the workflow to one vendor's primitive instead of fixing the class.

The existing recovery machinery does not cover this state:

- **`Auto-Finalize a Completed-But-Open Session`** explicitly "SHALL never close
  an incomplete session" — it requires the `round_completed` event to already
  exist. #146 has no such event, so auto-finalize correctly leaves it alone.
- **`Watchdog Reaping of Wedged Processes`** acts on a vendor `result` event or
  a hard deadline — #146's process is already gone, with no result to reap.
- **`Process-Supervision Liveness Sweep`** will eventually stamp the *execution*
  `orphaned` and cascade-close *processes*, but by its own deliberate asymmetry
  it leaves the `sessions` row `active` "so the in-progress round stays
  resumable" — it does not advance it.
- **`In-Dashboard "Continue Here" Resume`** can re-spawn the host, but it is
  **manual and one-click**, and re-enters without a forward-only guarantee.

So a run with unmet phases ahead of it has **no forward-resume owner**. This
change adds one, in two tiers, keyed entirely off the event log (never
filesystem inference), and proven to work headless on all four hosts.

## What Changes

- **A stranded mid-pipeline run becomes a first-class, detectable, recoverable
  state.** A new `session-management` requirement defines the predicate
  (`active` + no `round_completed` event for the current round + the owning turn
  ended) and makes such a run **forward-resumable from its `current_phase`**.
- **Forward target is the event-sourced `current_phase`, not a fabricated
  "validated phase".** The event log records phase *entry* (`phase_transition`)
  and the terminal `round_completed`; it carries no per-phase artifact-evidence
  event. So forward-resume re-enters `current_phase` and drives forward, never
  *regressing* it. Reuse of prior work (e.g. not re-running already-present
  reviewers) is a property of the **workflow's own idempotent phase execution**,
  not a guarantee re-derived from the event log.
- **Concurrency is guarded by a real single-writer resume lease**, not by
  inferring exclusion from an unrelated execution row. Each forward-resume
  appends a `session_resumed` event tagged `{kind: "forward_resume"}` (the
  existing event type, discriminated by metadata — no taxonomy change) in one
  transaction, admitted only if no live lease is held and the per-round lease
  count is below the cap. The continuation proceeds only if that insert wins —
  making the cap increment atomic and *append-before-spawn*, so an attempt that
  dies before doing work still counts (no unbounded retry). The lease event
  carries no `phase`/`round` (so it can't regress `current_phase` via the
  projection), is renewed on each `phase_transition`, and is held until
  `round_completed`/TTL so a multi-phase resume stays protected.
- **Bounded with an honest non-success terminal.** Attempts are bounded by
  `runtime.forward_resume_max_attempts` (default 2). On exhaustion the run is
  closed through the guarded path using the already-permitted
  `session_auto_closed_stale` reason with metadata `{reason:
  "forward_resume_exhausted"}` — a non-success terminal that preserves all
  artifacts for a manual fresh start. **No new event type, no schema migration,
  no `session_aborted`, never closed-as-success.**
- **Two tiers, honest about host reality.**
  - **Baseline (all four hosts, no daemon):** forward-resume is the human
    re-invoking the review skill; Phase 0 reads `next_action = forward_resume`
    and continues from `current_phase`. This needs **no** vendor resume adapter,
    **no** captured vendor session id, and **no** death-evidence gate. It works
    identically on every host.
  - **Dashboard-enhanced:** the `DbSyncWatcher` auto-detects the same predicate
    and auto-spawns the continuation, gated on positive death evidence (a clean
    parent-execution exit counts). Auto-spawn uses the per-vendor adapter, so it
    is available on hosts with a resume adapter (Claude Code, OpenCode today);
    on a host with no adapter the dashboard surfaces "Pick up in terminal" (the
    baseline path) instead of auto-spawning.
- **`status --json` gains a typed `next_action` enum** (`none | finish |
  forward_resume | abort_or_fresh`) plus `current_phase`, `remaining_phases`,
  and remaining attempts — one shared derivation read by the CLI, the watchdog,
  and the orchestrator.
- **`ocr review --resume` becomes a forward-only, lease-guarded, idempotent
  spawn convenience** (used by "Continue here" and terminal handoff), driven by
  a fixed CONTROL prompt ("read `status --json`; act on `next_action`") with all
  vendor delivery differences confined to the adapter; when no vendor id was
  captured it spawns a fresh forward-driving turn so work is not lost.
- **Dashboard renders the new states** (`forward_resume`, `abort_or_fresh`)
  honestly, and the orchestrator gets vendor-neutral guidance to drive to
  `complete-round` within the turn that produced the reviews (rate reduction,
  not a vendor primitive).

## Non-Goals

- **No change to Phase-4 spawning strategy.** *How* reviewers are instantiated
  (host self-spawn vs OCR child fan-out vs sequential) is owned by the in-flight
  `evolve-phase4-host-aware-spawning` change. This change operates strictly
  *downstream* on completion/recovery, keyed on OCR's own state. If a run stalls
  *inside* Phase 4, forward-resume re-enters `reviews` and the workflow's
  existing idempotency handles which reviewers to (re)spawn — it does not
  prescribe a spawn mechanism.
- **Stranded `map` runs are out of scope.** This change covers the `review`
  workflow; a symmetric treatment for map runs is deferred.
- **No verdict-vocabulary work.** A separate change
  (`enforce-verdict-count-direction`) tightens the verdict↔count gap.
- **No destructive migration and no taxonomy change.** Fix-forward; the
  non-success terminal reuses an existing close-guard reason.

## Impact

- Affected specs:
  - `session-management` — **ADDED** `Forward-Resume of a Stranded Mid-Pipeline
    Run` (predicate, `current_phase` forward-only rule, single-writer
    `session_resumed` lease, cap → non-success close, two tiers); **MODIFIED**
    `Auto-Finalize a Completed-But-Open Session` (delegation clause + defer to a
    live resume lease).
  - `sqlite-state` — **ADDED** `Stranded-Run Next-Action Derivation`
    (`current_phase`, `remaining_phases`, typed `next_action` enum; event-log
    sourced).
  - `cli` — **MODIFIED** `Atomic State Lifecycle Commands` (`status` typed
    `next_action` + forward-resume diagnostics); **MODIFIED** `Resume Flag on
    Existing Review Command` (forward-only, lease-guarded, CONTROL-prompt,
    fresh-turn fallback, cap-aware).
  - `review-orchestration` — **MODIFIED** `Atomic Completion Contract`
    (host-identical forward continuation from `current_phase`; vendor-neutral
    don't-end-mid-pipeline guidance).
  - `dashboard` — **ADDED** `DbSyncWatcher Auto-Forward-Resume of Stranded
    Sessions`; **ADDED** `Dashboard Rendering of Forward-Resume and Abort
    States`; **MODIFIED** `In-Dashboard "Continue Here" Resume` (shared primitive,
    forward-only, adapter-gated).
  - `config` — **ADDED** `Configurable Forward-Resume Cap and Lease`.
- Affected code (apply stage; for orientation):
  - `packages/shared/persistence/src/state/` — the stranded predicate, the
    `session_resumed` lease CAS, the shared `current_phase`/`remaining_phases`/
    `next_action` derivation over `orchestration_events`; `status --json`
    additions; the cap-exhaustion guarded close.
  - `packages/shared/platform/src/` — phase-graph walk helper (Node-free
    subpath) shared by CLI, watchdog, and orchestrator.
  - `packages/shared/config/src/runtime-config.ts` —
    `forward_resume_max_attempts`, `forward_resume_lease_seconds`.
  - `packages/cli/src/commands/review.ts` — `--resume` forward-only drive +
    CONTROL prompt + fresh-turn fallback + cap handling.
  - `packages/dashboard/src/server/services/db-sync-watcher.ts` and the resume
    runner — auto-forward-resume at sweep points, death-evidence gate, lease;
    client liveness header / affordances for the new states.
  - `packages/agents/skills/ocr/references/workflow.md` — the resume control loop
    (CONTROL only) and the don't-end-mid-pipeline guidance, edited in
    `packages/agents/` then synced via `nx run cli:update`.
- No schema migration; the predicate and derivation read existing
  `orchestration_events` / `agent_sessions` / `command_executions` rows, and the
  resume lease reuses the existing `session_resumed` event type.
