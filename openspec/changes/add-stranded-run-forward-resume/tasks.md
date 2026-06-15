# Tasks: Forward-Resume of a Stranded Mid-Pipeline Review

## 1. Shared derivation (single source of truth)

- [ ] 1.1 Add a Node-free phase-graph derivation in `packages/shared/platform/src/` (e.g. `./phase-graph` subpath) computing `currentPhase`, `remainingPhases`, and the `none | finish | forward_resume | abort_or_fresh` `next_action` from an `orchestration_events` projection — the one helper consumed by CLI, watchdog, and orchestrator
- [ ] 1.2 Re-export it from `packages/shared/platform/src/index.ts` (and a browser-safe subpath, matching the `./verdict` bundle-hygiene discipline)
- [ ] 1.3 Unit tests: `currentPhase` from the latest `phase_transition`; remaining-phase ordering; `forward_resume` vs `abort_or_fresh` (cap exhausted / no legal forward edge); event-log-only (a stray on-disk `final.md` is NOT completion evidence); **a sequential-strategy event log (N reviewer instances, no bound vendor ids, shared parent) yields the same `currentPhase` as the fanout-strategy log** (pins strategy-blindness)

## 2. Stranded predicate + resume lease + status surface (`sqlite-state` / `cli`)

- [ ] 2.1 Implement the stranded-mid-pipeline predicate in `packages/shared/persistence/src/state/` (active + no `round_completed` for the current round + owning turn ended), reusing the §1 derivation
- [ ] 2.2 Implement the single-writer resume lease: append a `session_resumed` event with metadata `{kind: "forward_resume"}` and **no `phase`/`round` column** in one transaction admitted only if (a) no live `forward_resume` lease within `forward_resume_lease_seconds`, (b) per-round `forward_resume` lease count < cap; the continuation proceeds only if the insert wins (atomic cap increment, append-before-spawn). The lease is **renewed on each `phase_transition`** and held until `round_completed` or TTL — never released on the first hop. Forward-resume continues from `current_phase` and does NOT use the `begin` re-open path
- [ ] 2.3 Amend the projection fold so a `forward_resume`-tagged `session_resumed` does NOT change `current_phase`/`current_round` (it carries no phase/round); add a guard so `ocr state begin` refuses to re-open an `active` session whose current round has no `round_completed` (route to forward-resume), preventing a context regression
- [ ] 2.4 Implement the cap-exhaustion guarded close via `session_auto_closed_stale` + metadata `{reason: "forward_resume_exhausted", attempts}`; child `agent_sessions` → `orphaned`; never success, never `session_aborted`
- [ ] 2.5 Extend `ocr state status --json` to emit the typed `next_action` enum plus `current_phase`, `remaining_phases`, and remaining attempts
- [ ] 2.6 Tests: stranded-at-reviews → `forward_resume` with correct phases; concurrent attempts → exactly one lease admitted; **a `forward_resume` lease does NOT change projected `current_phase`**; **lease renewed across a multi-phase resume, second owner refused while live**; attempt that dies before any `phase_transition` still consumes the cap; **`begin` on an active incomplete session is refused (no context regression)**; cap-exhausted → `abort_or_fresh` and a non-success `session_auto_closed_stale` close; `Auto-Finalize` defers to a live lease

## 3. Config (`config`)

- [ ] 3.1 Add `runtime.forward_resume_max_attempts` (default 2) and `runtime.forward_resume_lease_seconds` to `packages/shared/config/src/runtime-config.ts`, mirroring the `agent_heartbeat_seconds` shape (default / override / invalid-input rejection)
- [ ] 3.2 Tests: defaults; override; non-integer / `<1` rejected at load

## 4. Forward-only, idempotent resume spawn (`cli`)

- [ ] 4.1 Make `ocr review --resume` drive forward: read `current_phase` via `status --json`, acquire the lease, continue from `current_phase`, never regress, never duplicate a terminal event; inject the fixed CONTROL prompt ("read `ocr state status --json`; act on `next_action`")
- [ ] 4.2 Adapter path: when a resume adapter + captured `vendor_session_id` exist, dispatch via the vendor resume primitive; otherwise spawn a fresh host turn bound to the existing OCR session (continuity lost, work preserved)
- [ ] 4.3 On cap exhaustion, refuse and perform the non-success close; direct to `ocr state finish --abort` or a fresh review
- [ ] 4.4 Tests: forward-only reuse at `reviews`; idempotent repeated invocation; no-vendor-id fresh-turn fallback; cap refusal + close
- [ ] 4.5 Migrate the existing CLI test that asserts `--resume` with no captured vendor id exits non-zero without spawning → it now spawns a fresh forward-driving turn (intentional behavior reversal; confirm product intent)

## 5. Orchestrator resume loop + prevention nudge (`review-orchestration`, agent assets)

- [ ] 5.1 In `packages/agents/skills/ocr/references/workflow.md`, specify the resume control loop as CONTROL only — "read `ocr state status --json`; on `next_action=forward_resume` re-enter `current_phase`; the workflow reuses present artifacts" — with no vendor-specific spawn/background language
- [ ] 5.2 Add the vendor-neutral prevention guidance: drive to `complete-round` within the turn that produced the reviews; do not voluntarily end the turn between phases (rate reduction, not a vendor primitive)
- [ ] 5.3 State the host-identical guarantee (sub-agent fanout vs sequential shared-context) and the co-residence constraint
- [ ] 5.4 Run `nx run cli:update` to sync `.ocr/` from `packages/agents/`

## 6. Dashboard auto-forward-resume + rendering (enhanced tier)

- [ ] 6.1 In `packages/dashboard/src/server/services/db-sync-watcher.ts`, detect the stranded predicate at the existing sweep trigger points, gate on positive death evidence (clean parent-execution exit counts; stale heartbeat alone never), acquire the lease, and auto-spawn `ocr review --resume <id>` with the CONTROL prompt — reusing the §4 primitive, no second resume path
- [ ] 6.2 On a host with no resume adapter, do NOT auto-spawn; surface "Pick up in terminal"; honor the cap → non-success close
- [ ] 6.3 Client: render `forward_resume` as a recoverable stall (Continue here / Pick up in terminal) and `abort_or_fresh` with explicit "Start fresh" / "Mark abandoned" affordances; never as complete/success
- [ ] 6.4 Tests: dead+incomplete+adapter → auto-resume forward; live → no resume; no-adapter → terminal handoff; cap-exhausted → no resume, non-success close; new-state rendering
- [ ] 6.5 Migrate the existing dashboard test that asserts "Continue here" is disabled when no `vendor_session_id` → it is now disabled when no resume *adapter* exists (intentional contract swap); wire "Mark abandoned" to `ocr state finish --abort` through the existing socket command runner

## 7. Cross-host headless baseline proof (the blocking risk)

- [ ] 7.1 Add a deterministic stall-injection primitive (e.g. an env/flag that makes the workflow exit after entering `reviews` without reaching `complete-round`) so the stall is reproducible in CI, plus a synthetic stranded fixture for regression
- [ ] 7.2 With the dashboard NOT running, on each of Claude Code, OpenCode, Gemini, and Codex: force a mid-pipeline stall, then assert (a) `ocr state status --json` reports `forward_resume` with the correct `current_phase`/`remaining_phases`, (b) re-invoking the review skill recovers it forward from `current_phase` without regressing, (c) on the two `subagentSpawn:false` hosts the remaining phases complete within one turn (co-residence preserved), (d) the recorded `next_action` progression is identical across all four hosts, and (e) no step required a background process, poll, or daemon — only `ocr session` journaling and `ocr state` porcelain
- [ ] 7.3 Recover the real stranded session #146 forward (reviews → … → `complete-round` → `finish`) as a one-time live acceptance case (the synthetic fixture in §7.1 is the repeatable regression guard)

## 8. Validation

- [ ] 8.1 `openspec validate add-stranded-run-forward-resume --strict` passes
- [ ] 8.2 Full unit/integration suite green; no regression in `Auto-Finalize`, `Watchdog Reaping`, or `Process-Supervision Liveness Sweep` behavior
