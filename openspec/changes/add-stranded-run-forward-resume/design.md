# Design: Forward-Resume of a Stranded Mid-Pipeline Review

## Context

This design was converged by an architecture board (decomposition, state/CLI
contract, vendor-agnosticism, resilience/dashboard lenses) and then hardened by
an adversarial red-team pass that grounded its findings in the actual code.
Several first-draft assumptions were falsified against the implementation and
corrected here:

- The event log has **no per-phase artifact-evidence event**; `phase_transition`
  is emitted at phase *entry* and the only terminal artifact events are
  `round_completed`/`map_completed`. So "last validated phase derived from
  event-log artifact evidence" had no substrate → the forward target is the
  event-sourced `current_phase`, never regressed (D1).
- The cited "first-wins CAS" (`Finalization Is First-Wins Idempotent`) guards a
  `command_executions` finalization, not phase transitions → a real
  single-writer **resume lease** is introduced (D2).
- The closed `orchestration_events` taxonomy + close-guard admit no
  `resume_exhausted`/`orphaned` event → cap-exhaustion uses the existing,
  guard-permitted `session_auto_closed_stale` reason (D5).
- `buildResumeArgs` supports only `claude`/`opencode` and the resume command is
  today an interactive REPL drop → the baseline tier is *skill re-invocation*
  (all hosts, no adapter/token), and the spawn primitive is the adapter-gated
  dashboard convenience driven by a fixed CONTROL prompt (D3, D4).

## The state space (why the existing owners all decline #146)

| State | Signature | Owner | Action |
|---|---|---|---|
| Wedged process | vendor `result` ∧ won't exit | `Watchdog Reaping of Wedged Processes` | reap tree |
| Completed-but-open | `round_completed` ∧ `active` ∧ no dependents | `Auto-Finalize a Completed-But-Open Session` | guarded close → `complete` |
| Dead agent row | `agent_sessions` stale heartbeat | `Orphan Reclassification` / `Process-Supervision Liveness Sweep` | mark `orphaned` |
| **Stranded mid-pipeline (#146)** | no `round_completed` ∧ owning turn ended ∧ unmet phases ahead | **(none today)** | **— this change** |

`session_completeness` reads #146 as `open_no_artifact` — honest but inert.

## Decisions

### D1 — Forward target is the event-sourced `current_phase`; never regress

Completion evidence is the event log, never the filesystem. But the event log
only records phase *entry* and round completion — there is no "reviews validated"
event. So the resume target is `current_phase` (projected from the latest
`phase_transition`). Forward-resume re-enters `current_phase` and drives forward;
it MUST NOT regress `current_phase`. "Don't redo finished work" is delivered by
the **workflow's own idempotency** (Phase 4 re-spawns only the reviewers whose
outputs are absent), not by a state-layer claim that a phase's artifact is
validated. This is honest about what the substrate can prove and still safe: the
worst case is re-running an incomplete phase, which the workflow already handles
idempotently. The `current_phase`/`remaining_phases`/`next_action` derivation is
one shared pure function so CLI, watchdog, and orchestrator never disagree.

### D2 — A real single-writer resume lease (the concurrency guard)

The resume continuation is a long-lived agent turn *outside* any DB transaction,
so exclusion cannot be a row-level CAS at advance time. Instead each forward-
resume appends a `session_resumed` event tagged `{kind: "forward_resume"}`
(the existing event type, discriminated by metadata — `begin`'s new-round
re-open emits an untagged `session_resumed`, so the two never conflate) in one
transaction, admitted only if: (a) no live `forward_resume` lease within
`runtime.forward_resume_lease_seconds`; (b) the per-round `forward_resume` lease
count is below the cap. The continuation starts only if the insert wins. This single
construct provides mutual exclusion (one writer), an atomic cap increment, and
*append-before-spawn* counting — so two concurrent owners (the dashboard runs all
sweeps at startup) can't both drive the same round, and a continuation that dies
before doing work still consumes an attempt. Two further rules make the lease
sound against the existing projection/`begin` code: the lease event carries **no
`phase`/`round` column** (and the projection ignores `forward_resume`-tagged
`session_resumed`), so the lease can't regress `current_phase` via its own fold;
and the lease is **renewed on each `phase_transition` and held until
`round_completed`/TTL**, not released on the first hop, so a multi-phase resume
stays protected (TTL ≥ longest expected single phase; a lapse-while-alive is
bounded by the cap and harmless because resume is forward-only and
`complete-round` is idempotent). `Auto-Finalize` defers to a live lease so it
can't close a round out from under a continuation about to emit `round_completed`.

### D3 — Death evidence is a dashboard-tier gate only

The dashboard auto-tier MUST NOT force-restart a live run, so it resumes only on
positive death evidence — and a **clean parent-execution exit counts** as such
(the #146 shape), not only PID-confirmed death, so the gate is actually
satisfiable for the target population. The baseline tier needs no death gate: a
human re-invoking the skill *is* the liveness signal, and the lease makes a
double-run harmless.

### D4 — Two tiers, honest about the resume substrate

- **Baseline** = the human re-invokes the review skill. Phase 0 reads
  `next_action` and continues from `current_phase`. No adapter, no vendor token,
  every host. This is the existing resume model.
- **Dashboard-enhanced** = the watchdog auto-spawns via the per-vendor adapter,
  driven by a fixed CONTROL prompt ("read `status --json`; act on `next_action`")
  — never injected review context, so co-residence and vendor-neutrality hold.
  Auto-spawn needs an adapter (claude/opencode today); other hosts get "Pick up
  in terminal". The vendor resume token (`--resume <id>`) only preserves
  conversational continuity; when absent, a fresh forward-driving turn still
  recovers the work.

This dissolves the "all four hosts" problem: the *baseline* guarantee is
genuinely all-host (no adapter needed); the *auto* convenience is adapter-gated
and degrades to the baseline handoff elsewhere.

### D5 — Bounded with a guard-permitted non-success terminal

`runtime.forward_resume_max_attempts` (default 2) bounds the lease count. On
exhaustion the run is closed through the guarded path using
`session_auto_closed_stale` (an already-permitted close-guard reason) with
metadata `{reason: "forward_resume_exhausted", attempts}`; child `agent_sessions`
are `orphaned` per existing vocabulary. This is a non-success terminal that
preserves artifacts — never closed-as-complete, never `session_aborted`, and
requiring **no** new event type or schema migration. In the baseline tier the
`ocr review --resume` command performs this close when it detects exhaustion;
in the dashboard tier the watchdog does.

## Vendor-agnosticism (non-negotiable)

The CLI injects CONTROL, never CONTEXT. The predicate, lease, derivation,
`next_action`, and cap live in the CLI/shared layer and read identically on all
hosts — none branch on vendor. The only vendor-specific code is the dashboard
adapters' `spawn`/`buildResumeArgs`, which already own resume-flag differences.
**Co-residence preserved:** on `subagentSpawn:false` hosts the remaining phases
complete in one turn; forward-resume is a *next-turn* recovery, not a mid-turn
barrier, so it imposes no cross-process wait. The cross-host headless proof
(`tasks.md` §6) discharges this.

## Termination

After D2 (atomic append-before-spawn lease count) and D5 (a guard-permitted
terminal), the per-round `forward_resume` lease count is a strictly increasing,
persisted, atomic variant bounded by the cap; on reaching it the run is closed
non-success. The machine therefore always reaches a terminal state (`complete` |
non-success-closed | aborted) and cannot oscillate `active ↔ resume` forever.

## Boundary vs. `evolve-phase4-host-aware-spawning`

| Axis | `evolve-phase4-host-aware-spawning` | This change |
|---|---|---|
| Concern | Phase-4 *instantiation* | Phase-4→7 *completion/recovery* |
| Mechanism | `adapter.spawnReviewer` fan-out | predicate, lease, two-tier resume |
| Capability key | `supportsSubagentSpawn` | none — completion is capability-independent |

This change MUST NOT touch `adapter.spawnReviewer`, the Phase-4 fan-out, or
`OCR Does Not Own Phase 4 Process Spawning`.

## Alternatives considered

- **Add a per-phase artifact-evidence event** so "last validated phase" is real.
  Rejected: it needs a taxonomy/schema migration this change explicitly avoids,
  and `current_phase` + workflow idempotency achieves the same safety without it.
- **Decompose the single-turn pipeline into separately-invocable skills.**
  Rejected (prior 4–0 board verdict): breaks sequential-host co-residence and
  raises the new-vendor bar.
- **Let the dashboard own a bespoke resume.** Rejected: a second resume path can
  drift from the headless one and leaves headless users with no recovery.
- **Auto-abort on cap exhaustion.** Rejected: `session_aborted` reads as a user
  decision; the automated terminal must be distinguishable and artifact-
  preserving → `session_auto_closed_stale` with a reason.

## Risks

- **Lease correctness under the startup sweep storm** (all sweeps fire at once).
  Mitigated by D2's single admitted writer; primary test target.
- **Death-evidence too strict (false-live-forever) / too loose (force-restart a
  live run).** Mitigated by D3 (clean exit counts; baseline needs no gate).
- **Vendor leak into the substrate.** Guarded by keeping all resume logic in the
  CLI/shared layer; enforced by the cross-host headless proof.
