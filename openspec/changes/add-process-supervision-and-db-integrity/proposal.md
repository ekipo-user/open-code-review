# Change: Process supervision + database integrity hardening

## Why

A dashboard-spawned `ocr review` completed its work and posted its review, then **wedged alive for 44+ minutes**, and the database had grown to **298 MB** (84,611 FK-orphan rows + a NULL-defeats-UNIQUE markdown-duplication bug — one artifact had 775 identical copies). Both were confirmed empirically. Root causes: finalization hinged on `proc.on('close')` (stdio EOF), which a leaked grandchild daemon held open forever; the parent execution row was never heart-beaten; nothing reaped the escaped process tree; and the markdown writer used `INSERT OR REPLACE` against a UNIQUE index that NULL-round artifacts never matched.

## What Changes

- **Process supervision**: detached agent processes are `unref`'d; finalization is driven by the vendor `result` event (work done) and a per-execution **watchdog** (reaps a wedged-but-alive process whose work is done, or one past a hard deadline) — no longer by stdio EOF. A cross-platform `reapTree` kills the whole descendant tree (robust to `setsid()` escape) on cancel, watchdog, and singleton takeover. `finishExecution` is first-wins idempotent.
- **Liveness heartbeat**: the parent execution row's `last_heartbeat_at` is bumped on output activity (throttled) and by the supervisor tick, so long reviews no longer drift to "stalled."
- **DB integrity**: the markdown writer is now an explicit UPDATE-or-INSERT; a migration (v14) collapses existing duplicates and adds a NULL-safe unique index so the dup bug cannot recur. Orphan `ocr.db.<pid>.tmp` files are reaped on dashboard startup.
- **Single dashboard instance**: a live prior OCR-dashboard is reaped (tree) and taken over instead of coexisting on an incremented port.

## Scope of this change vs. follow-ups

Implemented + tested here: process supervision (WS-A), heartbeat (WS-B), DB write-path + self-heal migration (WS-D), startup `.tmp` reaper, singleton takeover (WS-F). Tracked follow-ups (separate, lower-risk-when-isolated): `reconcileWorkflowOnExit` to auto-close an `active`+`complete` session via the guarded `stateClose` (WS-C); operator commands `ocr db doctor/prune/vacuum` (WS-E); and file-stdio redirection as belt-and-suspenders for the pipe-inheritance trap (the `result`-finalize + `reapTree` already break the wedge).

## Impact

- Affected specs: `session-management`, `sqlite-state`, `dashboard`
- Affected code: `packages/shared/platform/src/index.ts` (`reapTree`/`descendantPids`/`isProcessAlive`), `packages/dashboard/src/server/socket/command-runner.ts`, `packages/dashboard/src/server/services/ai-cli/{claude,opencode}-adapter.ts`, `packages/dashboard/src/server/index.ts`, `packages/dashboard/src/server/services/filesystem-sync.ts`, `packages/cli/src/lib/db/migrations.ts`
