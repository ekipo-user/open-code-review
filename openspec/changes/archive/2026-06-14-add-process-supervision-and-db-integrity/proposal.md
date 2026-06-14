# Change: Process supervision + database integrity hardening

## Why

A dashboard-spawned `ocr review` completed its work and posted its review, then **wedged alive for 44+ minutes**, and the database had grown to **298 MB** (84,611 FK-orphan rows + a NULL-defeats-UNIQUE markdown-duplication bug — one artifact had 775 identical copies). Both were confirmed empirically. Root causes: finalization hinged on `proc.on('close')` (stdio EOF), which a leaked grandchild daemon held open forever; the parent execution row was never heart-beaten; nothing reaped the escaped process tree; and the markdown writer used `INSERT OR REPLACE` against a UNIQUE index that NULL-round artifacts never matched.

## What Changes

- **Process supervision**: detached agent processes are `unref`'d; finalization is driven by the vendor `result` event (work done) and a per-execution **watchdog** (reaps a wedged-but-alive process whose work is done, or one past a hard deadline) — no longer by stdio EOF. A cross-platform `reapTree` kills the whole descendant tree (robust to `setsid()` escape) on cancel, watchdog, and singleton takeover. `finishExecution` is first-wins idempotent.
- **Liveness heartbeat**: the parent execution row's `last_heartbeat_at` is bumped on output activity (throttled) and by the supervisor tick, so long reviews no longer drift to "stalled."
- **DB integrity**: the markdown writer is now an explicit UPDATE-or-INSERT; a migration (v14) collapses existing duplicates and adds a NULL-safe unique index so the dup bug cannot recur. Orphan `ocr.db.<pid>.tmp` files are reaped on dashboard startup.
- **Single dashboard instance**: a live prior OCR-dashboard is reaped (tree) and taken over instead of coexisting on an incremented port.
- **State finalization (WS-C)**: `reconcileWorkflowOnExit` / `reconcileCompletedSessions` auto-close an `active`+`complete` session through the guarded `stateClose` — no-op unless the round is complete and the workflow has quiesced — driven both per-execution and by the startup/periodic sweep. Exported via the `@open-code-review/persistence/state` subpath.
- **Operator DB maintenance (WS-E)**: `ocr db doctor [--fix] / vacuum / prune` productizes the corruption remediation — health report, FK-orphan sweep (system-of-record tables protected, `PRAGMA foreign_keys` toggled in autocommit), markdown dedup, snapshot-before-mutate, `VACUUM`, and retention that prunes only the derived-artifact subtree of old closed sessions (never events/sessions). The `.tmp` reaper is extracted to the shared maintenance module.
- **File-stdio isolation (WS-A hardening)**: detached agents write stdout/stderr to a per-execution log file (`data/exec-logs/<uid>.log`) instead of OS pipes; a `FileTailer` streams it to the existing parser (UTF-8-boundary-safe), so a leaked grandchild can never hold a pipe whose EOF blocks finalization. Stale logs are reaped past 7 days. Also fixes a latent `finishExecution` CAS bug (the engine's `run()` discards the `changes` count — now read via `prepare().run()`).

## Impact

- Affected specs: `session-management`, `sqlite-state`, `dashboard`
- Affected code: `packages/shared/platform/src/index.ts` (`reapTree`/`descendantPids`/`isProcessAlive`), `packages/dashboard/src/server/socket/command-runner.ts`, `packages/dashboard/src/server/services/ai-cli/{claude,opencode}-adapter.ts` + `file-tailer.ts`, `packages/dashboard/src/server/index.ts`, `packages/dashboard/src/server/services/filesystem-sync.ts`, `packages/shared/persistence/src/db/{migrations,maintenance,reconcile,index}.ts`, `packages/shared/persistence/src/state/index.ts`, `packages/cli/src/commands/db.ts`
