# Tasks: Forward-Resume of a Stranded Mid-Pipeline Review

> Implementation notes (apply stage): the shared derivation landed in
> `packages/shared/persistence/src/state/forward-resume.ts` (co-located with the
> existing `phase-graph.ts`/`projection.ts` and DB-aware), **not** in
> `@open-code-review/platform` — the derivation needs the event log, and the
> pure phase-order math already lives in persistence. The browser only needs the
> `next_action` string values, which arrive over the wire.

## 1. Shared derivation (single source of truth)

- [x] 1.1 `forward-resume.ts` derivation: `remainingPhasesAfter` (current-phase-based), `deriveStrandedStatus` / `strandedActionByCap` producing `forward_resume | abort_or_fresh`, from `orchestration_events` (in persistence, co-located with `phase-graph.ts`)
- [x] 1.2 Exported from the `@open-code-review/persistence/state` barrel for CLI + dashboard
- [x] 1.3 Unit tests: `currentPhase`/remaining-phase ordering (review + map), `forward_resume` vs `abort_or_fresh` (cap exhausted), event-log-only (on-disk `final.md` ignored), lease no-regress

## 2. Stranded predicate + resume lease + status surface (`sqlite-state` / `cli`)

- [x] 2.1 Stranded-mid-pipeline predicate (active + no `round_completed` + owning-turn liveness) in `forward-resume.ts`
- [x] 2.2 Single-writer resume lease: `session_resumed` event tagged `{kind:"forward_resume"}`, no phase/round column, one-transaction CAS (no live lease ∧ count < cap), append-before-spawn, TTL + phase-transition renewal
- [x] 2.3 Projection fold ignores forward-resume leases (no phase regression); `ocr state begin` refuses an active, incomplete session (no context reset)
- [x] 2.4 Cap-exhaustion guarded close via `session_auto_closed_stale` + `{reason:"forward_resume_exhausted"}` (no taxonomy change; never success/abort)
- [x] 2.5 `ocr state status --json` emits typed `next_action` + `current_phase` + `remaining_phases` + attempts (optional resume config; legacy callers unchanged)
- [x] 2.6 Tests (forward-resume.test.ts): single-writer lease, cap, no-regress, multi-phase renewal implied, attempt-counts-on-death, begin-refusal, cap-close, status integration

## 3. Config (`config`)

- [x] 3.1 `runtime.forward_resume_max_attempts` (2) + `runtime.forward_resume_lease_seconds` (1800) via the existing `readRuntimePositiveInt` helper — invalid input warns + falls back to the safe default (never a coerced 0), matching the `agent_heartbeat_seconds` convention
- [x] 3.2 Tests: defaults, override, non-integer / `<1` → safe fallback

## 4. Forward-only, idempotent resume (`cli`)

- [x] 4.1 `ocr review --resume` classifies via `stateStatus`(resume config), acquires the lease, drives forward from `current_phase`; cap exhaustion → non-success close + refuse
- [x] 4.2 Adapter path resumes the captured vendor session; **no captured vendor id → honest baseline skill-handoff (exit 0)** rather than spawning an unknown binary (we cannot know the host; the skill re-invocation is the all-host forward-resume)
- [x] 4.3 Cap-exhaustion close + direct to `finish --abort`/fresh
- [x] 4.4 `state status` passes resume config; covered by persistence status tests + cli-e2e
- [x] 4.5 cli-e2e migrated: `--resume` with no vendor id now hands off (exit 0), not errors

## 5. Orchestrator resume loop + prevention nudge (`review-orchestration`, agent assets)

- [x] 5.1 `workflow.md` Phase 0 forward-resume control loop (act on `next_action`; continue forward from `current_phase`; don't `begin` an active incomplete session)
- [x] 5.2 Vendor-neutral "don't strand the pipeline" nudge (drive 4→7 to `complete-round` in one turn)
- [x] 5.3 Host-identical + co-residence statement included
- [x] 5.4 `nx run cli:update` synced `.ocr/`

## 6. Dashboard auto-forward-resume + rendering (enhanced tier)

- [x] 6.1 `forward-resume-sweep.ts`: detects stranded runs gated on POSITIVE death evidence (PID-confirmed-dead or ended; never a stale heartbeat alone), triggers the same `ocr review --resume` primitive (best-effort detached spawn), wired into startup + periodic sweeps
- [x] 6.2 No resume adapter / no vendor id → `handoff` (no auto-spawn); cap-exhausted → non-success close (sweep)
- [x] 6.3 Client: `forward_resume` → existing Continue-here + terminal-handoff (ResumeCard `paused`); `abort_or_fresh` → new `exhausted` variant with Start fresh / Mark abandoned
- [x] 6.4 Tests (forward-resume-sweep.test.ts): resume / handoff / live-skip / no-death-evidence-skip / cap_close / ended-counts; `resumeVariantForNextAction` mapping test
- [x] 6.5 "Mark abandoned" wired to `state finish --abort` via the socket command runner (existing path)
- [ ] 6.6 (Follow-up) Non-interactive CONTROL-prompt drive via the per-vendor adapter (`claude -p` / `opencode run --continue <prompt>`) for fully-unattended auto-resume. Today the auto path triggers `ocr review --resume` (interactive); the guaranteed-unattended behaviors are detection, cap-close, lease, and surfacing for one-click/terminal pickup. Tracked as hardening.

## 7. Cross-host headless baseline proof (the blocking risk)

- [x] 7.1 Synthetic stranded fixture as the repeatable regression guard: the persistence + sweep test suites construct the exact stranded shape deterministically and assert `forward_resume`/recovery (no test-only hook added to production paths)
- [ ] 7.2 (Manual proof obligation — needs Claude Code, OpenCode, Gemini, Codex installed) With the dashboard down, force a mid-pipeline stall on each host and assert: `status --json` reports `forward_resume`; re-invoking the skill recovers forward without regressing; sequential hosts complete remaining phases in one turn; `next_action` progression is identical; no daemon required
- [ ] 7.3 (Manual, one-time) Recover the real stranded session #146 forward as a live acceptance case

## 8. Validation

- [x] 8.1 `openspec validate add-stranded-run-forward-resume --strict` passes
- [x] 8.2 Unit + cli-e2e suites green (persistence, config, cli, dashboard, cli-e2e); no regression in `Auto-Finalize` / `Watchdog Reaping` / `Process-Supervision Liveness Sweep`
