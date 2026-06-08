/**
 * Shared SQLite database access module for OCR.
 *
 * Uses `better-sqlite3` (native, on-disk, WAL) for durable, cross-process
 * SQLite access. The database lives at `.ocr/data/ocr.db` within a project.
 * Engine specifics live in `./engine.ts`; this module owns connection
 * lifecycle, migrations, and re-exports.
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { openEngine, type Database } from "./engine.js";
import { runMigrations, getSchemaVersion } from "./migrations.js";
import { reconcileLegacyState } from "./reconcile.js";

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
 */
function maybeSnapshotBeforeUpgrade(db: Database, dbPath: string): void {
  let version: number;
  try {
    version = getSchemaVersion(db);
  } catch {
    return;
  }
  if (version < 1 || version >= V2_SCHEMA_VERSION) return;
  const bakPath = `${dbPath}.bak.v${version}`;
  if (existsSync(bakPath)) return; // already snapshotted on a prior attempt
  try {
    if (!existsSync(dbPath) || statSync(dbPath).size === 0) return;
    db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(dbPath, bakPath);
  } catch {
    // Snapshot is best-effort insurance; never block the upgrade on it.
  }
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
  linkDashboardInvocationToWorkflow,
  setAgentSessionStatus,
  updateAgentSession,
  sweepStaleAgentSessions,
  sweepStaleSessions,
} from "./agent-sessions.js";

export type { WorkflowType, SessionStatus } from "../state/types.js";

export { runMigrations, MIGRATIONS } from "./migrations.js";

export { resultToRows, resultToRow } from "./result-mapper.js";

export type { Database, ExecResult, ExecResultRow, SqlValue, BindParams } from "./engine.js";
export { probeEngine } from "./engine.js";
export { reconcileLegacyState } from "./reconcile.js";
export type {
  ReconcileResult,
  ReconcileAction,
  ReconcileKind,
  ReconcileOptions,
} from "./reconcile.js";
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
 * Opens or creates a SQLite database at the given path via better-sqlite3.
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
 * No-op persistence shim.
 *
 * Under the prior sql.js engine the entire database lived in memory and had
 * to be serialized to disk after every mutation. With better-sqlite3 + WAL,
 * writes are persisted by the engine as part of each statement/transaction,
 * so there is nothing to flush. Retained as a symbol so the ~30 existing
 * `saveDatabase(db, path)` / `saveDb(db)` call sites do not all need editing;
 * durability is now the engine's responsibility.
 */
export function saveDatabase(_db: Database, _dbPath: string): void {
  // Intentionally empty — better-sqlite3 + WAL persists on commit.
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
  maybeSnapshotBeforeUpgrade(db, dbPath);
  runMigrations(db);

  // On crossing into the v2 event-sourced model, heal legacy state (derive
  // truth from events + filesystem artifacts) once, automatically. Runs after
  // the schema is in place; safe to skip on any error so it never blocks
  // opening the database.
  if (before < V2_SCHEMA_VERSION) {
    try {
      reconcileLegacyState(db, ocrDir);
    } catch (err) {
      console.error(
        `[ocr] legacy reconciliation skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  saveDatabase(db, dbPath);

  return db;
}

/**
 * Checkpoint-truncate the on-disk write-ahead log through a native
 * better-sqlite3 connection, keeping the main `.db` file current (e.g. so an
 * older sql.js build could still read it after a downgrade).
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
      transient?.raw.close();
    } catch {
      // already closed / never opened
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
