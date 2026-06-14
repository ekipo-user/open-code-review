## 1. Process supervision (WS-A)

- [x] 1.1 `reapTree` / `descendantPids` / `isProcessAlive` in `@open-code-review/platform` (POSIX tree-walk + Windows `taskkill /T`)
- [x] 1.2 `result` event in the claude parser + `NormalizedEvent` union
- [x] 1.3 First-wins idempotent `finishExecution` (CAS on `finished_at IS NULL`, clears watchdog)
- [x] 1.4 Per-execution watchdog: reap-on-result-grace + hard-deadline (exit code -5)
- [x] 1.5 Cancel reaps the whole tree via `reapTree`; detached spawns `unref`'d
- [x] 1.6 Platform tests for `isProcessAlive` / `descendantPids` / `reapTree`

## 2. Liveness heartbeat (WS-B)

- [x] 2.1 Parent-row heartbeat bumped on stdout activity (throttled) + supervisor tick

## 3. DB integrity (WS-D)

- [x] 3.1 `upsertMarkdownArtifact` → explicit UPDATE-or-INSERT (no more `INSERT OR REPLACE` append)
- [x] 3.2 Migration v14: collapse duplicates + NULL-safe unique index
- [x] 3.3 Migration tests (dedup + index enforcement)

## 4. Orphan files + singleton (WS-E partial, WS-F)

- [x] 4.1 Dashboard startup reaps `ocr.db.<pid>.tmp` orphans (PID + age guarded)
- [x] 4.2 Single-instance: reap prior OCR-dashboard tree + take over (no port-increment coexistence)

## 5. State finalization (WS-C)

- [x] 5.1 `reconcileWorkflowOnExit` + `reconcileCompletedSessions` — auto-close `active`+`complete` sessions via the guarded `stateClose` (no-op unless complete + quiesced); exported via the `@open-code-review/persistence/state` subpath
- [x] 5.2 Wire into dashboard `finishExecution` (per-execution, fire-and-forget) + startup/periodic sweep
- [x] 5.3 `hasInFlightDependents` promoted to the db barrel as the single "in flight" predicate; reconcile-on-exit tests

## 6. Operator DB maintenance (WS-E full)

- [x] 6.1 `maintenance.ts`: `collectDbHealth`, `fixDb` (FK-orphan sweep via ordered anti-joins with `PRAGMA foreign_keys` toggled in autocommit + system-of-record tables protected), `vacuumDb`, `pruneDb`, snapshot-before-mutate
- [x] 6.2 `ocr db doctor [--fix] / vacuum / prune` command; live-dashboard exclusive-lock guard; `--dry-run` for prune
- [x] 6.3 `reapOrphanDbFiles` extracted to the shared maintenance module (dashboard reaper now re-uses it); maintenance tests

## 7. File-stdio process isolation (WS-A hardening)

- [x] 7.1 Detached workflow spawns redirect stdout/stderr to a per-execution log file (`data/exec-logs/<uid>.log`) instead of OS pipes; parent closes its fd + `unref`s
- [x] 7.2 `FileTailer` streams the log to the existing parse loop (UTF-8-boundary-safe via `StringDecoder`); drained on close; tests
- [x] 7.3 `reapStaleExecLogs` prunes logs older than 7 days on dashboard startup
- [x] 7.4 Fix: `finishExecution` CAS now reads `changes` via `prepare().run()` (the engine's `run()` discards it)

## 8. Type-safety gate + backup hygiene (post-review)

- [x] 8.1 Per-package `tsconfig.typecheck.json` (`noEmit`) covering BOTH source and test files (vitest types added) + `typecheck` nx targets + `nx.json` default + CI job gating e2e — closes the gap that let the CAS bug ship (no build/test step typechecks)
- [x] 8.2 Fix all pre-existing type errors the gate surfaces — source: `db/types.ts` + `progress/types.ts` re-export-without-local-binding (`SessionStatus`/`WorkflowType`), `state/index.ts` `computeRoundCounts` return type (was mis-annotated `SynthesisCounts`), dashboard `api-types.ts` `UnresumableReason` re-export, `workflow-output.tsx` noUncheckedIndexedAccess; tests: `noUncheckedIndexedAccess` array-access guards (reviewers/discourse tests), an unused `@ts-expect-error`, and an unsafe `StreamEvent` cast
- [x] 8.3 `ocr db prune-backups [--keep N] [--dry-run]` + `pruneBackups` lib (keeps N most-recent, never touches the live DB); reclaimed the live 285 MB pre-remediation snapshot

## 9. Round-1 multi-agent review address (PR #36)

- [x] 9.1 **Blocker SF1**: startup orphan-kill + graceful shutdown now `reapTree` the whole descendant tree (were `process.kill(-pid)` — missed `setsid()`-escaped grandchildren at every restart boundary, recurring the wedge)
- [x] 9.2 SF2: `process.title = 'ocr-dashboard'` + anchored `^ocr-dashboard` identity (path substring kept as macOS fallback); SF8: cli `build:bundle` target-level `dependsOn` dashboard instead of project-wide `implicitDependencies` (un-inverts the layering)
- [x] 9.3 SF4/S11: `finishExecution` applies cancel-wins centrally so a late watchdog/close can't relabel a cancelled run; S14: watchdog probes `isProcessAlive` before reaping (recycled-PID guard); S3: takeover spin-wait → async sleep
- [x] 9.4 SF9: `WATCHDOG_DEADLINE_EXIT_CODE` (-5) moved to `exit-codes.ts`, re-exported via the db barrel, explicitly recognized in `command-outcome`; bare `-2` literals → `CANCELLED_EXIT_CODE`; S26: hard deadline configurable via `runtime.workflow_hard_deadline_minutes`
- [x] 9.5 SF6: `escapeUserHeaders` NFKC-folds + strips zero-width/bidi + normalizes U+2028/2029 (NBSP/RLO/ZWSP/fullwidth bypass tests)
- [x] 9.6 S13: `reapTree` returns `{signaled, psAvailable}` + WARNs on SIGKILL-grace stragglers; S17: shared `withForeignKeysDisabled` (prod + test fixture); S18: shared `buildFileStdio`/`closeFileStdio`; S20: `reconcileWorkflowOnExit` accepts a db handle; S21: outcome logging; S22: shared `clearSpawnMarker`; S12: `prune-backups --keep 0` requires `--force`
- [x] 9.7 SF5 (declined as written): OpenCode has no terminal `result` sentinel — `step_finish` is per-step; mapping it would mis-fire the watchdog. Documented the intentional asymmetry (OpenCode finalizes via file-stdio'd `close` + hard deadline). SF16 (declined): migration v14 dedup SQL kept independent of `maintenance.MARKDOWN_DEDUP_SQL` — migrations are frozen history; coupling would let an edit retroactively change v14
- [x] 9.8 Follow-up batch now implemented (was deferred): **S10** typed notice events (capability + hard-deadline) routed through the event stream; **S15** greedy `--requirements` arg parsing fixed; **S19** heartbeat writer extracted to `makeHeartbeatBumper` (watchdog.ts) with direct DB tests; **S23** first-wins `tryClaimFinalization` extracted (finalizer.ts) with tests; **S24** asymmetric cross-package tsconfig include removed (dashboard typecheck resolves cli types via `exports` alone); **S25** per-execution spawn markers + path-traversal sanitization + ambiguity decline, with fs tests; **S27** subpath-export graduation rule documented in CLAUDE.md (storage-package extraction at the 9th subpath); **S28** command-runner god class decomposed into process-registry/spawn-markers/prompt-builder/watchdog/finalizer leaf+dependent modules (no cycles, backward-compat re-exports); **SF7** typecheck gates added for agents + the 3 e2e packages

## 10. Round-2 multi-agent review address (PR #36 — verdict APPROVE)

- [x] 10.1 **SF1**: watchdog tick extracted into pure `decideWatchdogTick` — the round-1 S14 liveness guard now gates the SIGNAL (reap only when the child handle shows `!exited`), never the finalize; deadline branches finalize regardless of liveness; exited-no-result children get `wait` (no heartbeat bump) so the sweep's orphan backstop stays armed. 8 pinning tests incl. the two named discourse invariants
- [x] 10.2 **SF2**: `prune-backups --keep <non-numeric>` NaN bypass closed at BOTH boundaries — `validatePruneBackupsOptions` (pure, exported, 11-case table test) rejects non-integer/negative keep; `pruneBackups` throws on the same (no more `Math.max(0, NaN)` clamp-through)
- [x] 10.3 **SF3**: shutdown reaps with a short grace (`reapTree(pid, 750)`) and awaits ~1s inside the 2s force-exit budget so the SIGKILL escalation + straggler WARN actually fire before the pid-nulling UPDATE; keep-pid-populated rejected per the reparenting analysis (escapees reparent to PID 1 — the only effective window is during shutdown itself)
- [x] 10.4 **SF4**: the hard-deadline remediation notice is appended to `entry.outputBuffer` before finalize, so the persisted -5 row and its JSONL backup carry it (typed-event routing remains in the rescoped S10 deferral)
- [x] 10.5 **SF5**: enumerated invisible-char strip replaced with `\p{Cf}` (category-complete: bidi isolates U+2066–2069, soft hyphen, all future Cf additions); pinning tests for the U+2066 bypass closing and the deliberate soft-hyphen drop; ZWJ-emoji tradeoff documented at the strip site
- [x] 10.6 **SF6**: both load-bearing Nx invariants recorded in config, not prose alone — `cli:build:bundle` gained explicit dashboard-source `inputs` (future caching becomes safe, not silently stale) + `metadata.description`; `dashboard:build`'s cycle-breaking `dependsOn: []` got a `metadata.description` naming the task cycle it prevents
- [x] 10.7 **S1/Info**: comment-drift batch — `ProcessEntry.cancelled` (cancel-wins lives in finishExecution now), `-5` doc (no longer promises an unbuilt "timed out" rendering), watchdog header (result-grace is Claude-only), U+2028 comment (ECMA-262 DOES treat LS/PS as LineTerminators — the fold is normalization, not a regex gap fix), startup-reap escalation note, `ReapResult.signaled` doc nit
- [x] 10.8 **S5**: `psAvailable` derived from the walk's own `ps` invocation (TOCTOU probe removed, one fewer spawn per reap); degraded-reaping WARN logged centrally in `reapTree`; straggler WARN reworded (counted pre-kill: "sending SIGKILL")
- [x] 10.9 **S6** (partial): dead `is_detached` reads dropped from both restart-boundary SELECTs; SQL-embedded `-2` literals parameterized via `CANCELLED_EXIT_CODE` (column retirement migration stays in the deferred follow-up)
- [x] 10.10 **S3**: vitest alias hybrid resolved on the dist side — the cli source aliases were empirically dead (vitest externalizes the symlinked package; Node `exports` resolution precedes vite aliases/conditions), so they are deleted with the resolution model documented in vitest.config; platform resolves to source via its own `exports`; the `dashboard:test → cli:build` edge is the (only) reliable mechanism
- [x] 10.11 **S7**: pipe-fallback decided as a SUPPORTED DEGRADED MODE (documented at the fallback site: differs in promptness, never in outcome, since SF1 made the deadline finalizes stdio-independent); OpenCode result-exemption + revisit note added as spec scenarios alongside the existing adapter comment
- [x] 10.12 Round-2 follow-up now implemented (was deferred): **S2** sweep/finalize ownership boundary documented as the finalizer.ts module contract (in-memory claim de-dupes same-process triggers; DB CAS `WHERE finished_at IS NULL` de-dupes across processes during the handoff window); **S4** `cli:build:lib` split landed — the cost condition was met (the old `dashboard:test → cli:build → build:bundle → dashboard:build` edge forced a full vite dashboard rebuild + cli bundle on every dashboard source edit, though dashboard tests consume only cli's library subpaths), so `build.mjs` gained a `--lib-only` flag, a `cli:build:lib` target (deps `^build` only, ~0.9s vs ~9s) was added, and `dashboard:test` repointed to it; **non-null-assertion residue** cleared as part of the SF7 typecheck-gate batch
