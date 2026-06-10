# Tasks: Durable, event-sourced state lifecycle (v2.0.0)

Ordered for independently-green commits on branch `fix/incomplete-workflow-shown-as-success`. Each numbered group should leave `nx run-many -t build,test` green.

## 1. Engine migration (sql.js → better-sqlite3 + WAL)
- [x] 1.1 Add `better-sqlite3` dependency; remove `sql.js`; mark `better-sqlite3` `external` in `packages/cli/build.mjs` and the dashboard esbuild bundle
- [x] 1.2 Introduce a result-shape adapter exposing the used subset (`exec`→`{columns,values}[]`, `run`, `prepare`) so existing `resultToRows`/`db.exec` call sites are minimally churned
- [x] 1.3 Rewrite `openDatabase`/`ensureDatabase` (`packages/cli/src/lib/db/index.ts`) for native open + pragmas (`WAL`, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`); add `BEGIN IMMEDIATE` + bounded `SQLITE_BUSY` retry helper
- [x] 1.4 Make `saveDatabase` a no-op shim; replace `walCheckpointTruncate` shellout with a native `wal_checkpoint(TRUNCATE)`; checkpoint on `closeDatabase`
- [x] 1.5 Dashboard: delete `DbSyncWatcher` merge logic, mtime watermark, `registerSaveHooks`, and `db.export()`/`saveDb` writes; keep a lightweight file watcher only for "re-query + Socket.IO push"
- [x] 1.6 Port `runMigrations` to native transactions; full existing suite green (`nx run-many -t build,test` + `e2e` cli-e2e/dashboard-api-e2e)
- [x] 1.7 `ocr doctor`: add a native-module load check with platform/build-tools remediation messaging

## 2. Migration v12 (schema, constraints, views, reconciliation)
- [x] 2.1 v12 migration scaffold: pre-migration snapshot `ocr.db → ocr.db.bak.<fromVersion>`
- [x] 2.2 `event_type` taxonomy guard (CHECK/trigger) over the canonical vocabulary incl. `session_aborted`, `session_legacy_import`
- [x] 2.3 Indexes: `sessions(status)`, `orchestration_events(session_id, created_at)`
- [x] 2.4 `session_completeness` view (`complete` / `closed_without_artifact` / `in_flight` / `open_no_artifact` + per-obligation booleans)
- [x] 2.5 `BEFORE UPDATE OF status` close-guard trigger (abort `closed` without terminal artifact or reason event); installed AFTER reconciliation
- [x] 2.6 Remove the deprecated `state.json` dual-write from all state commands
- [x] 2.7 Migration round-trip test from a captured pre-v12 (sql.js-written) fixture DB

## 3. Legacy reconciliation
- [x] 3.1 `reconcile` core: derive truth from events + artifacts; synthesize `round_completed` from provable `final.md`; grandfather via `session_legacy_import` otherwise; auto-close stale via `session_auto_closed_stale`
- [x] 3.2 `ocr state reconcile [--dry-run]`; emit auditable reconciliation events; idempotent
- [x] 3.3 Wire reconciliation into the v12 migration (runs before the close-guard trigger install)
- [x] 3.4 Tests: synthesize case, grandfather case, stale-close case, dry-run no-op, double-run idempotency

## 4. Event-sourced projection + single-writer
- [x] 4.1 Make every lifecycle mutator write event + `sessions` projection in one transaction; projection never written independently
- [x] 4.2 Projection-rebuild helper (recompute `sessions` from a session's events) + test asserting equality
- [x] 4.3 Enforce write-ownership: dashboard lifecycle mutations shell out to `ocr state`; dashboard writes only supervision + UX tables
- [x] 4.4 Concurrency regression test: external-process `close` + `current_round` bump survive a concurrent dashboard write; `deriveCommandOutcome` returns `success`

## 5. Atomic agent API (porcelain)
- [x] 5.1 `ocr state begin` (resolve via `--session-id` → env uid → single-active; refuse on ambiguity; JSON out)
- [x] 5.2 `ocr state advance --phase` (graph-validated; derive `phase_number`)
- [x] 5.3 `ocr state complete-round --stdin` (one transaction: validate + assert synthesis + write meta + event + advance + transition; idempotent)
- [x] 5.4 `ocr state complete-map --stdin` (map analogue)
- [x] 5.5 `ocr state finish [--abort]` (refuse on incomplete; `--abort` → `session_aborted`)
- [x] 5.6 `ocr state status --json` (reads `session_completeness`; per-obligation booleans + `next_action`)
- [x] 5.7 Exit-code taxonomy (0/2/3/4/5/6/7); typed error→code mapping; JSON output wrapped with `schema_version`
- [x] 5.8 Keep `transition`/`round-complete`/`close` as deprecated plumbing shims that emit correct events + print pointer
- [x] 5.9 Tests: each verb success + each refusal path + idempotency + exit codes

## 6. Dashboard outcome derivation
- [x] 6.1 `deriveCommandOutcome`/history route read `session_completeness`; teach the `-4` cascade sentinel; force a fresh read before the `command:finished` outcome
- [x] 6.2 Surface `incomplete` consistently in command center + history; "Resume in terminal" affordance
- [x] 6.3 Tests: closed-without-artifact → `incomplete`; genuine completion → `success`

## 7. Orchestrator contract
- [x] 7.1 Rewrite `packages/agents/skills/ocr/references/{workflow,session-state,map-workflow}.md` to use the atomic porcelain; document that the CLI refuses incorrect sequences
- [x] 7.2 Ensure `ocr update` ships the new references; deprecation pointers verified

## 8. Release v2.0.0
- [x] 8.1 Verify better-sqlite3 prebuild matrix vs supported platforms (incl. Windows, ref #23)
- [x] 8.2 Full `nx run-many -t build,test` + all e2e green; manual: premature `finish` rejected; legacy fixture auto-heals on upgrade with no user action
- [x] 8.3 READMEs/CHANGELOG: engine change, native dep, atomic API, automatic migration
- [x] 8.4 Cut `2.0.0` via the nx release flow (released; `v2.0.0` tag at `chore(release): 2.0.0`)

## 9. Spec archive (post-merge, separate PR)
- [x] 9.1 `openspec archive redesign-durable-state-lifecycle --yes`; update `specs/`; `openspec validate --strict`
