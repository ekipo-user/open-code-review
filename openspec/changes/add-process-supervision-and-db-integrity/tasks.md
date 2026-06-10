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

- [x] 5.1 `reconcileWorkflowOnExit` + `reconcileCompletedSessions` — auto-close `active`+`complete` sessions via the guarded `stateClose` (no-op unless complete + quiesced); exported via a new `@open-code-review/cli/state` subpath
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
