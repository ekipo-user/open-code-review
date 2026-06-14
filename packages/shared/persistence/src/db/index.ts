/**
 * Shared SQLite database access module for OCR.
 *
 * Uses Node's built-in `node:sqlite` (on-disk, WAL) for durable, cross-process
 * SQLite access. The database lives at `.ocr/data/ocr.db` within a project.
 * Engine specifics live in `./engine.ts`; this module owns connection
 * lifecycle, migrations, and re-exports.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  statSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openEngine, type Database } from "./engine.js";
import { runMigrations, getSchemaVersion } from "./migrations.js";
import { reconcileLegacyState } from "./reconcile.js";
import type { ReconcileResult } from "./reconcile.js";

/**
 * Schema version that introduces the v2.0 event-sourced lifecycle. Databases
 * below this are snapshotted before the upgrade (see {@link ensureDatabase}).
 */
const V2_SCHEMA_VERSION = 12;

/**
 * Snapshot an existing pre-v2 database to `ocr.db.bak.v<n>` before applying
 * the v12 upgrade — cheap, total recoverability for local-first users. A
 * brand-new database (version 0) is skipped. WAL is checkpoint-truncated
 * first so the copied main file is current.
 *
 * Returns the backup path when a snapshot was written, else `null`.
 */
function maybeSnapshotBeforeUpgrade(
  db: Database,
  dbPath: string,
  fromVersion: number,
): string | null {
  if (fromVersion < 1 || fromVersion >= V2_SCHEMA_VERSION) return null;
  const bakPath = `${dbPath}.bak.v${fromVersion}`;
  if (existsSync(bakPath)) return bakPath; // already snapshotted on a prior attempt
  try {
    if (!existsSync(dbPath) || statSync(dbPath).size === 0) return null;
    db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(dbPath, bakPath);
    return bakPath;
  } catch {
    // Snapshot is best-effort insurance; never block the upgrade on it.
    return null;
  }
}

/**
 * Compose the one-time stderr notice shown when an existing pre-v2 database is
 * upgraded. Pure + exported so it can be unit-tested. Returns `null` when
 * there's nothing worth announcing (defensive; the caller only invokes it on a
 * real upgrade).
 */
export function formatUpgradeNotice(
  bakPath: string | null,
  reconcile: ReconcileResult | undefined,
): string | null {
  const lines = [
    "Storage upgraded to v2.0 — durable SQLite engine (WAL), event-sourced lifecycle.",
  ];
  if (bakPath) {
    lines.push(`  A backup of your previous database was saved to: ${bakPath}`);
  }
  const repairs = (reconcile?.actions ?? []).filter((a) => a.kind !== "ok");
  if (repairs.length > 0) {
    const n = (kind: string) => repairs.filter((a) => a.kind === kind).length;
    const parts: string[] = [];
    const finalized =
      n("synthesize-round-completed") + n("synthesize-map-completed");
    if (finalized > 0) parts.push(`${finalized} finalized from artifacts`);
    if (n("grandfather") > 0) parts.push(`${n("grandfather")} grandfathered`);
    if (n("stale-close") > 0) parts.push(`${n("stale-close")} stale closed`);
    lines.push(
      `  Reconciled ${repairs.length} legacy session(s): ${parts.join(", ")}.`,
    );
  }
  lines.push("  Run `ocr doctor` to verify the storage engine.");
  return lines.map((l) => `[ocr] ${l}`).join("\n");
}

// Re-export public types and functions
export type {
  AgentSession,
  AgentSessionRow,
  AgentSessionStatus,
  AgentVendor,
  EventRow,
  InsertAgentSessionParams,
  InsertEventParams,
  InsertSessionParams,
  Migration,
  SchemaVersionRow,
  SessionRow,
  SweepResult,
  UpdateAgentSessionParams,
  UpdateSessionParams,
} from "./types.js";

export {
  insertSession,
  updateSession,
  getSession,
  getLatestActiveSession,
  getAllSessions,
  insertEvent,
  getEventsForSession,
  getLatestEventId,
  commitReasonClose,
} from "./queries.js";

export {
  insertAgentSession,
  getAgentSession,
  listAgentSessionsForWorkflow,
  getLatestAgentSessionWithVendorId,
  bumpAgentSessionHeartbeat,
  setAgentSessionVendorId,
  bindVendorSessionIdOpportunistically,
  recordVendorSessionIdForExecution,
  SAFE_VENDOR_SESSION_ID,
  isSafeVendorSessionId,
  linkDashboardInvocationToWorkflow,
  setAgentSessionStatus,
  updateAgentSession,
  sweepStaleAgentSessions,
  sweepStaleSessions,
  cascadeTerminateExecutions,
  rowKind,
} from "./agent-sessions.js";

// Process-liveness primitives — shared by the dashboard's supervision paths
// (startup orphan-kill + the periodic liveness sweep) so the "is this pid
// alive?" policy and the PID-reuse guard are defined once.
export {
  type IsAlive,
  defaultIsAlive,
  PID_REUSE_GUARD_MS,
  sqliteUtcMs,
} from "./liveness.js";

export type { WorkflowType, SessionStatus } from "../state/types.js";

// Canonical exit-code taxonomy, error class, and the negative process
// sentinels — surfaced through the db barrel so the dashboard (which imports
// from `@open-code-review/persistence`) can branch on them without reaching into
// the state module's internals.
export {
  STATE_EXIT,
  StateError,
  CANCELLED_EXIT_CODE,
  ORPHAN_EXIT_CODE,
  CASCADE_CLOSE_EXIT_CODE,
  WATCHDOG_DEADLINE_EXIT_CODE,
} from "../state/exit-codes.js";

export { runMigrations, MIGRATIONS } from "./migrations.js";

export { resultToRows, resultToRow } from "./result-mapper.js";

// `Database` carries no `raw` handle (see engine.ts) — the published
// `@open-code-review/persistence` contract cannot leak the node:sqlite type.
export type { Database, ExecResult, ExecResultRow, SqlValue, BindParams } from "./engine.js";
export { probeEngine, isBusyError } from "./engine.js";
export { reconcileLegacyState, hasInFlightDependents } from "./reconcile.js";
export type {
  ReconcileResult,
  ReconcileAction,
  ReconcileKind,
  ReconcileOptions,
} from "./reconcile.js";
export {
  collectDbHealth,
  snapshotDb,
  reapOrphanDbFiles,
  reapStaleExecLogs,
  fixDb,
  vacuumDb,
  pruneDb,
  pruneBackups,
  withForeignKeysDisabled,
} from "./maintenance.js";
export type {
  DbHealthReport,
  FkViolationGroup,
  OrphanTempFile,
  BackupFile,
  DbFixOptions,
  DbFixResult,
  DbVacuumResult,
  DbPruneOptions,
  DbPruneResult,
  DbPruneSessionPlan,
  DbPruneBackupsResult,
} from "./maintenance.js";
export { getSchemaVersion } from "./migrations.js";

export {
  cacheDir,
  generateCommandUid,
  commandLogPath,
  appendCommandLog,
  readCommandLog,
  replayCommandLog,
} from "./command-log.js";

export type {
  CommandLogEntry,
  CommandLogEvent,
  CommandLogWriter,
} from "./command-log.js";

// ── Connection cache ──

const connections = new Map<string, Database>();

/**
 * Opens or creates a SQLite database at the given path via node:sqlite.
 * Connections are cached by path for reuse within a process. The directory
 * is created on demand so callers don't have to pre-create `data/`.
 */
export async function openDatabase(dbPath: string): Promise<Database> {
  const cached = connections.get(dbPath);
  if (cached) {
    return cached;
  }

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = openEngine(dbPath);
  connections.set(dbPath, db);
  return db;
}

/**
 * Convenience function: opens the OCR database at `.ocr/data/ocr.db`
 * within the given OCR directory.
 */
export async function getDb(ocrDir: string): Promise<Database> {
  const dbPath = join(ocrDir, "data", "ocr.db");
  return openDatabase(dbPath);
}

/**
 * Creates the data directory if needed, opens the database, runs migrations,
 * and persists the result. Callable from both CLI and dashboard server.
 */
export async function ensureDatabase(ocrDir: string): Promise<Database> {
  const dataDir = join(ocrDir, "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = join(dataDir, "ocr.db");
  const db = await openDatabase(dbPath);
  let before = 0;
  try {
    before = getSchemaVersion(db);
  } catch {
    before = 0;
  }
  // An upgrade of an EXISTING pre-v2 database (not a brand-new install, which
  // starts at version 0). Used to gate the snapshot, reconciliation, and the
  // one-time notice — all of which run exactly once per machine because, after
  // this, `before` is always >= V2_SCHEMA_VERSION.
  const isLegacyUpgrade = before >= 1 && before < V2_SCHEMA_VERSION;

  const bakPath = maybeSnapshotBeforeUpgrade(db, dbPath, before);
  runMigrations(db);

  // On crossing into the v2 event-sourced model, heal legacy state (derive
  // truth from events + filesystem artifacts) once, automatically. Runs after
  // the schema is in place; safe to skip on any error so it never blocks
  // opening the database.
  let reconcile: ReconcileResult | undefined;
  if (before < V2_SCHEMA_VERSION) {
    try {
      reconcile = reconcileLegacyState(db, ocrDir);
    } catch (err) {
      console.error(
        `[ocr] legacy reconciliation skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // One-time, hands-off migration visibility. Emitted to STDERR so it never
  // pollutes machine-readable stdout (e.g. `ocr state status --json`). Fires
  // only when an existing pre-v2 database was actually upgraded.
  if (isLegacyUpgrade) {
    const notice = formatUpgradeNotice(bakPath, reconcile);
    if (notice) console.error(notice);
  }

  return db;
}

/**
 * Checkpoint-truncate the on-disk write-ahead log through a native
 * node:sqlite connection, so the main `.db` file stays current and the
 * `.db-wal` sidecar doesn't grow without bound.
 *
 * Reuses the cached connection when one exists; otherwise opens a transient
 * one. Never throws — callers treat this as best-effort hygiene.
 *
 * Returns:
 *  - "checkpointed" — the checkpoint pragma ran
 *  - "skipped"      — the database file does not exist
 *  - "failed"       — the checkpoint raised (reported, not thrown)
 */
export type WalCheckpointResult = "checkpointed" | "skipped" | "failed";

export function walCheckpointTruncate(dbPath: string): WalCheckpointResult {
  if (!existsSync(dbPath)) {
    return "skipped";
  }

  const cached = connections.get(dbPath);
  if (cached) {
    try {
      cached.pragma("wal_checkpoint(TRUNCATE)");
      return "checkpointed";
    } catch {
      return "failed";
    }
  }

  let transient: Database | undefined;
  try {
    transient = openEngine(dbPath);
    transient.pragma("wal_checkpoint(TRUNCATE)");
    return "checkpointed";
  } catch {
    return "failed";
  } finally {
    try {
      // Let the adapter own its close protocol (idempotent + pre-close
      // checkpoint) rather than reaching past it to `raw.close()`.
      transient?.close();
    } catch {
      // best-effort hygiene — never throw from the checkpoint helper
    }
  }
}

/**
 * Closes a database connection and removes it from the cache.
 */
export function closeDatabase(dbPath: string): void {
  const db = connections.get(dbPath);
  if (db) {
    db.close();
    connections.delete(dbPath);
  }
}

/**
 * Closes all cached database connections. Useful for cleanup in tests.
 */
export function closeAllDatabases(): void {
  for (const [path, db] of connections) {
    db.close();
    connections.delete(path);
  }
}

/**
 * Deeper engine health check than {@link probeEngine}: exercises a real
 * **on-disk WAL transaction round-trip** — `openEngine` + `BEGIN IMMEDIATE` +
 * a write + a read-back — in a throwaway temp database. `probeEngine` only
 * proves the engine *opens* (`:memory:`); this proves the journaled write path
 * (`transaction()`) the install gate relies on actually works. Used by
 * `ocr doctor --probe-write`.
 */
export function probeWrite(): { ok: true } | { ok: false; error: string } {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "ocr-probe-"));
    const db = openEngine(join(dir, "probe.db"));
    try {
      db.run("CREATE TABLE _probe_write (id INTEGER PRIMARY KEY, v TEXT)");
      db.transaction(() => {
        db.run("INSERT INTO _probe_write (v) VALUES (?)", ["written-in-txn"]);
      });
      const value = db.exec("SELECT v FROM _probe_write")[0]?.values[0]?.[0];
      if (value !== "written-in-txn") {
        return { ok: false, error: `unexpected probe value: ${String(value)}` };
      }
      return { ok: true };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (dir) rmDirBestEffort(dir);
  }
}

/**
 * Remove a temp dir, retrying a few times with a short backoff: on Windows the
 * OS can hold the just-closed `node:sqlite` file handle briefly, so a single
 * `rmSync` can race. Best-effort — never throws (ephemeral CI runners tolerate
 * a residual dir, but we try not to leak one).
 */
function rmDirBestEffort(dir: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 2) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
