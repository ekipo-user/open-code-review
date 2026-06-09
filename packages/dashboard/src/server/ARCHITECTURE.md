# Dashboard Server Architecture

## Single-Writer Ownership Model

The CLI and dashboard share ONE on-disk SQLite database at `.ocr/data/ocr.db`,
opened with `node:sqlite` in WAL mode. Native WAL locking serializes writes
across both processes — there is no in-memory copy, no merge layer, and no save
hooks. The dashboard's connection reads committed CLI writes live.

### CLI-Owned Tables (Workflow Lifecycle)

The CLI is the sole writer of the workflow lifecycle:

- **sessions** -- lifecycle, phase tracking, branch metadata
- **orchestration_events** -- phase transitions, workflow events

The dashboard only reads these. The single exception is the bounded
"legacy/backfill reconciler" in `services/filesystem-sync.ts`, which backfills
historical sessions discovered on disk (and safety-net-closes a session whose
terminal artifact landed but whose `ocr state` close never ran). Those rare
lifecycle touches route through the CLI's event-backed helpers
(`insertSession` + a `session_created` event, and `commitReasonClose`) so the
close-guard trigger ordering and projection invariants are respected.

### Dashboard-Owned Tables

The dashboard owns supervision state and parsed artifact/UX state:

- **command_executions** -- command/agent-session history and output logs
- **review_rounds** -- round metadata, verdicts, blocker counts (parsed)
- **reviewer_outputs** -- per-reviewer file paths, finding counts (parsed)
- **review_findings** -- individual findings parsed from reviewer output
- **map_runs** -- map run metadata, file counts (parsed)
- **map_sections** -- section groupings within a map run (parsed)
- **map_files** -- individual files within map sections (parsed)
- **markdown_artifacts** -- raw markdown content for review/map outputs
- **user_file_progress** -- file review checkboxes
- **user_finding_progress** -- finding triage status (read, fixed, wont_fix, etc.)
- **user_round_progress** -- round-level triage status
- **user_notes** -- free-text notes attached to any entity
- **chat_conversations** -- AI chat session metadata
- **chat_messages** -- individual chat messages

These writes are user- and parse-driven and happen in response to UI
interactions and filesystem-sync runs.

## Durability and Concurrency

Durability is the engine's job: `node:sqlite` persists writes on commit and
WAL locking serializes them across the CLI and dashboard connections. There is
no explicit flush, no merge-before-write, and no temp-file-then-rename — the
shared on-disk database with native locking handles all of it.

## Change Notification

`DbSyncWatcher` watches `ocr.db` (and its `-wal` sidecar) for external writes
from the CLI. Its sole job is *notification*: it diffs the live database against
cached snapshots and emits the granular Socket.IO events the dashboard UI
subscribes to. It performs no merge writes — the CLI-owned tables are already
authoritative on the shared connection.
