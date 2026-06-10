## Context

OCR is a local-first, single-user, AI-orchestrated code review tool. State lives in `.ocr/data/ocr.db`. Two kinds of processes touch it: short-lived `ocr` CLI invocations (driven by the orchestrating AI and by the dashboard) and a long-lived dashboard server (Express + Socket.IO + React). The recurring production failure — "session marked complete too soon" — was diagnosed by a four-discipline review board (architecture, CLI/DX, durability, data-design) against PR #31. The board's unanimous finding: the PR improves *detection* of an adjacent failure but does not *prevent* the headline bug, and a separate concurrent-writer race can corrupt state independent of agent behavior.

This change implements the board's converged recommendation, scoped to "the right thing for local-first single-user" — durable, single-writer, event-derived lifecycle with an atomic API — while explicitly declining distributed-systems gold-plating that the context does not warrant.

## Goals / Non-Goals

**Goals**
- Make "closed but not actually complete" **unrepresentable**, not merely detectable.
- Give orchestrating agents an atomic, semantic, misuse-proof state API.
- Guarantee state is **always consistent and durable** (the user's explicit constraint on Decision 1).
- Fully automatic, hands-off migration for existing users.
- Heal existing corrupted state (Wrkbelt-class stragglers) on upgrade.

**Non-Goals**
- Distributed consensus, multi-user, or networked state.
- Tamper-evident / hash-chained event logs.
- A generic CQRS read-model-rebuild framework.
- A long-lived state daemon (the per-call CLI must remain the lowest common denominator across the 14 supported AI tools).
- Building the MCP server now (design for it; ship later).

## Decisions

### D1 — Event-sourced lifecycle (CQRS-lite); `sessions` is a derived projection
The `orchestration_events` log is the single source of truth for lifecycle (status, phase, round, completion). `sessions` columns and a `session_completeness` view are **projections** maintained transactionally from events, never written independently. Completion is a fold over events (`∃ round_completed{round=current}` + a terminal event), so there is no mutable "complete" flag to lie. Content tables (findings, reviewer outputs, map sections) stay tabular — they are write-once artifacts, not contested state.
- *Always-consistent + durable (user constraint):* every lifecycle mutation writes the event **and** updates the projection **in one `better-sqlite3` transaction**; WAL makes the commit durable and visible to readers atomically. Projection can never diverge from the log because they commit together; if they ever did, the projection is rebuildable from the log.
- *Alternatives considered:* (a) full event sourcing for all data — rejected as overkill for write-once content; (b) keep state-oriented model with events as audit — rejected, that is today's bug.

### D2 — Single-writer per bounded context
- **Lifecycle** (`sessions`, `orchestration_events`): the `ocr state` CLI is the sole writer. The dashboard's "run review" action spawns `ocr state …` like every other AI tool; it never writes lifecycle directly.
- **Process supervision** (`command_executions`: PIDs, heartbeats, exit codes, vendor session ids): dashboard-owned (it spawns the processes).
- **Review content** (findings, reviewer outputs, maps): written by whoever parses the artifact.
- **Dashboard UX** (notes, triage, chat): dashboard-owned.

These contexts already map cleanly to distinct tables, so no physical table split is required — only enforcement of write-ownership. This makes DB triggers a true backstop (defense-in-depth) rather than the primary guard.

### D3 — Engine: `better-sqlite3` + WAL
Replaces sql.js. Real transactions enable D1's atomicity; WAL gives OS-level single-writer/multi-reader locking, eliminating the concurrent-writer clobber class by construction. The current schema was explicitly built in anticipation of this: `applyPragmas` already sets WAL/busy_timeout/foreign_keys (no-ops under sql.js), `walCheckpointTruncate` already shells to native sqlite3, and `sqlite-state` spec already contains "future native-SQLite engine" scenarios. We:
- Open with `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`.
- Use `BEGIN IMMEDIATE` for write transactions; retry on `SQLITE_BUSY` with bounded backoff.
- Delete `DbSyncWatcher`'s merge logic, the mtime watermark, `registerSaveHooks`, and `db.export()` writes. `saveDatabase` becomes a no-op shim (kept as a symbol to bound call-site churn); checkpoint on close.
- Keep a *lightweight* file watcher only to trigger "re-query + Socket.IO push to clients" — never to merge state.
- **Result-shape adapter:** better-sqlite3 returns row objects; the codebase uses sql.js's `{columns, values}` via `db.exec`/`resultToRows`. Introduce a thin internal adapter exposing the used subset (`exec`, `run`, `prepare`) so existing call sites are minimally churned; new code uses prepared statements directly.
- *Alternatives considered:* (a) patch the merge layer, stay on sql.js — rejected, perpetuates a hand-rolled MVCC layer that re-implements what the engine gives for free; (b) make the dashboard the single writer over IPC — heavier, and D2 (CLI sole lifecycle writer) achieves single-writer more simply.

### D4 — Atomic, semantic, misuse-proof agent API
Porcelain verbs, each one transaction, invariant-checked, idempotent, typed exit codes:

| Verb | Meaning | Guarantees |
|---|---|---|
| `ocr state begin` | start/resume | resolves session (`--session-id` → `OCR_DASHBOARD_EXECUTION_UID` → single-active; refuses on ambiguity); returns `{session_id, round, phase, completeness}` |
| `ocr state advance --phase <n>` | reached phase X | graph-validated; **`phase_number` derived** (no dual-field desync) |
| `ocr state complete-round --stdin` | round finished | one transaction: validate meta + assert `current_phase=synthesis` (proves the graph path was walked) + write round-meta.json + `round_completed` event + advance round + transition to `complete`; all-or-nothing; idempotent |
| `ocr state complete-map --stdin` | map run finished | analogous for maps (`map_completed` for `current_map_run`) |
| `ocr state finish [--abort]` | close workflow | refuses unless `round_completed` exists for current round; `--abort` writes `session_aborted` (never renders as success) |
| `ocr state status --json` | what's done / missing | reads completeness view; per-obligation booleans + `next_action` |

Exit-code taxonomy: `0` ok, `2` usage, `3` ambiguous-session, `4` not-found, `5` illegal-transition, `6` invariant-unmet, `7` schema-invalid. Designed MCP-ready (typed JSON in/out). Low-level `transition`/`round-complete`/`close` retained as deprecated shims that emit the right events so half-upgraded environments don't break.

### D5 — Dual-layer enforcement (migration v12)
- **App guards:** in `complete-round`/`finish` (D4).
- **DB backstop:** (a) `event_type` taxonomy guard (CHECK/trigger) so a typo can't corrupt derivation; (b) `BEFORE UPDATE OF status` close-guard trigger aborting `status='closed'` unless a terminal artifact event (`round_completed`/`map_completed` for the current round/run) **or** an explicit reason event (`session_aborted`/`session_auto_closed_stale`/`session_synced`/`session_legacy_import`) exists — only *silent* premature close is banned, so all legitimate non-artifact closes pass; (c) `session_completeness` view as the published completion contract the dashboard reads; (d) indexes for the now-periodic sweeps (`sessions(status)`, `orchestration_events(session_id, created_at)`).

## Migration Plan

Five dimensions, all automatic (Decision 4 constraint: "just works"):
1. **Engine** — file format is identical; better-sqlite3 opens `ocr.db` in place; first open enables WAL.
2. **Schema** — forward-only, transactional, idempotent migration v12 via the existing version-tracked runner (auto-invoked by `ensureDatabase`/`openDb` on every open). Expand/contract for any semantic change; never a flag day.
3. **Reconciliation** — `ocr state reconcile` (also run inside v12): derive true state from events + artifacts; **synthesize** `round_completed` from a provable `final.md`, **grandfather** (emit `session_legacy_import`) otherwise, auto-close stale. Idempotent, `--dry-run`, logged via reconciliation events. Runs before the strict close-guard trigger is installed so legacy rows don't trip it.
4. **In-flight sessions** — because lifecycle is now derived, an old-model session's projection is simply recomputed on first read; resumes cleanly. Deprecated plumbing commands keep working.
5. **Contract** — `ocr update` ships the atomic-verb `workflow.md`; the version-drift notifier nudges; deprecated commands print a pointer to the porcelain.

**Safety:** snapshot `ocr.db → ocr.db.bak.<fromVersion>` before v12 (cheap, total recoverability). Migration runner is transactional + idempotent (crash-safe — the thing fixing interrupted-state bugs must not corrupt on interruption).

**Rollback / downgrade:** WAL is checkpoint-truncated on clean shutdown so the main file is always current and an older sql.js build can still read it. Hard downgrade with an un-checkpointed WAL requires a manual `wal_checkpoint`; documented.

## Risks / Trade-offs

- **Native dependency (top risk)** → better-sqlite3 prebuilt binaries cover the supported matrix; `ocr doctor` verifies the native module loaded; clear "install build tools / unsupported platform" message on failure; verify against the project's cross-platform/Windows posture (#23).
- **Engine swap churns many query call sites** → result-shape adapter preserves the used sql.js surface; migrate incrementally; full suite must stay green per commit.
- **Close-guard trigger rejects a legitimate close** → reason-event carve-out; reconciliation runs before trigger install; explicit test per close path (normal, abort, stale-sweep, backfill).
- **Reconciliation mis-heals** → synthesize only when artifacts *prove* completion; `--dry-run` prints the plan; every change emits an auditable reconciliation event; DB snapshot taken first.

## Migration verification

- Concurrency regression test (the one PR #31 lacks): external-process writes `status closed` + a `current_round` bump to the file; trigger a dashboard write for an unrelated table; assert both survive and `deriveCommandOutcome` returns `success`.
- Round-trip migration test from a captured pre-v12 (sql.js-written) fixture DB → assert WAL enabled, v12 applied, reconciliation correct (synthesized vs grandfathered cases), snapshot created.
- Trigger-rejection tests for each close path.

## Open Questions

- None blocking. (`state.json` removal, MCP timing, and reconcile aggressiveness were resolved with the user: remove state.json writes; defer MCP; synthesize-when-provable.)
