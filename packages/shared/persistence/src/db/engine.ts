/**
 * SQLite engine adapter — backs OCR's database access with Node's built-in
 * `node:sqlite` (`DatabaseSync`, on-disk, WAL). Synchronous and cross-process
 * safe via WAL + OS-level file locking, with **no native dependency to
 * install** — the engine ships inside Node itself, so there is no prebuilt
 * binary, no ABI matrix, and no install script for a package manager to skip.
 *
 * The adapter preserves the small `exec`/`run`/`close` surface the codebase
 * already uses, so the ~100 existing query call sites keep working unchanged.
 * New code SHOULD prefer the native primitives exposed here — `prepare()`,
 * `transaction()`, `pragma()`, and the `raw` handle.
 *
 * The engine LOAD is self-guarding: it requires Node >= 22.5 (when `node:sqlite`
 * landed) and suppresses the experimental warning at the point it actually
 * loads `node:sqlite` — so every entry point (the `ocr` bin, the
 * `@open-code-review/persistence` subpath, the bundled dashboard server) is covered
 * by construction, not by who imported the bin's runtime-guard first.
 */

import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  isSupportedNode,
  isSuppressibleSqliteWarning,
  nodeVersionGuardMessage,
} from "../runtime-checks.js";

/** SQLite primary result codes for write-lock contention. */
const SQLITE_BUSY = 5;
const SQLITE_BUSY_SNAPSHOT = 261;

/** Bounded retry budget for write transactions that hit SQLITE_BUSY. */
const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_BACKOFF_MS = 50;

/** Name for the SAVEPOINT at a given nesting depth. */
const savepointName = (depth: number): string => `ocr_sp_${depth}`;

// `createRequire` so the lazy load works in source AND in every bundle (the cli
// bundle, the `./db` library bundle, the dashboard server bundle), regardless of
// the banner's `require`.
const nodeRequire = createRequire(import.meta.url);

/**
 * Apply the engine's runtime preconditions exactly once, at the point the engine
 * actually loads — so EVERY entry point is guarded by construction. Suppresses
 * only node:sqlite's experimental warning, installed before the built-in is
 * required so the warning can never fire.
 */
let _preconditionsApplied = false;
function applyEnginePreconditions(): void {
  if (_preconditionsApplied) return;
  _preconditionsApplied = true;
  const originalEmitWarning = process.emitWarning.bind(process) as (
    ...args: unknown[]
  ) => void;
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    if (isSuppressibleSqliteWarning(warning)) return;
    originalEmitWarning(warning, ...args);
  }) as typeof process.emitWarning;
}

// Load `node:sqlite` LAZILY (synchronous `require`, not a static import) so that
// importing this module does NOT touch the built-in until a DB is actually
// opened — which lets the preconditions above run first.
let _DatabaseSyncCtor: { new (path: string): DatabaseSync } | undefined;
function newDatabase(path: string): DatabaseSync {
  if (!_DatabaseSyncCtor) {
    applyEnginePreconditions();
    try {
      _DatabaseSyncCtor = (
        nodeRequire("node:sqlite") as typeof import("node:sqlite")
      ).DatabaseSync;
    } catch (e) {
      // On a too-old runtime `node:sqlite` does not exist. Turn the opaque
      // "Cannot find module 'node:sqlite'" into the actionable guard message —
      // this is what protects library/dashboard-server entry points that never
      // run the bin's early Node-version guard.
      if (!isSupportedNode(process.versions.node)) {
        throw new Error(nodeVersionGuardMessage(process.versions.node).trim());
      }
      throw e;
    }
  }
  return new _DatabaseSyncCtor(path);
}

/** A value that can be bound to a parameter or returned from a column. */
export type SqlValue = number | string | bigint | Buffer | Uint8Array | null;

/**
 * True when `e` is a `node:sqlite` lock-contention error. `node:sqlite`
 * surfaces the generic `code === "ERR_SQLITE_ERROR"` and puts the SQLite
 * primary result code in `errcode` — for both `exec`-level and prepared
 * statement (`StatementSync#run`/`#all`) busy errors (verified). Keying on
 * `errcode` is load-bearing: get it wrong and the busy-retry loop silently
 * never fires under contention.
 */
export function isBusyError(e: unknown): boolean {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  return errcode === SQLITE_BUSY || errcode === SQLITE_BUSY_SNAPSHOT;
}

// One shared buffer for `sleepSync` — the value at index 0 never changes, so it
// is safe to reuse across all calls (avoids a fresh SAB per contended retry).
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

/**
 * Block the current thread for `ms` milliseconds. Synchronous because
 * `transaction()` is synchronous — we cannot `await` a timer mid-transaction.
 * `Atomics.wait` parks the thread without busy-spinning the CPU.
 */
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

/** Positional bind parameters for `exec`/`run`. */
export type BindParams = ReadonlyArray<SqlValue>;

/**
 * Mirror of a `sql.js` `exec()` result set: an array (one entry per
 * row-returning statement) of `{columns, values}`. The codebase only ever
 * runs single statements through `exec`, so this array has length 0 (no
 * rows) or 1 (rows present), so `resultToRows`/`resultToRow` work verbatim.
 */
export interface ExecResultRow {
  columns: string[];
  values: SqlValue[][];
}
export type ExecResult = ExecResultRow[];

/**
 * The OCR database handle. Method shapes for `exec`/`run`/`close` match the
 * legacy surface; `prepare`/`transaction`/`pragma` are native additions.
 *
 * Deliberately does NOT expose the underlying `node:sqlite` handle: keeping the
 * raw connection off the interface is what makes "engine.ts is the only seam"
 * an INVARIANT, not a convention — no consumer of `@open-code-review/persistence`
 * (the dashboard, any third party) can reach past the adapter and couple to the
 * engine. The adapter still holds the raw handle internally.
 */
export interface Database {
  /**
   * Run a single SQL statement and return its rows in `sql.js` shape.
   * Returns `[]` when the statement returns no rows.
   */
  exec(sql: string, params?: BindParams): ExecResult;
  /**
   * Execute a statement (or, when no params are given, one-or-more
   * statements — used by the migration runner) for its side effects.
   */
  run(sql: string, params?: BindParams): void;
  /** Prepare a single statement for repeated/typed execution. */
  prepare(sql: string): StatementSync;
  /** Run `fn` inside a single IMMEDIATE transaction (all-or-nothing). */
  transaction<T>(fn: () => T): T;
  /** Issue a PRAGMA against the underlying connection. */
  pragma(source: string): unknown;
  /** Checkpoint the WAL and close the connection. */
  close(): void;
}

class NodeSqliteAdapter implements Database {
  readonly raw: DatabaseSync;
  /**
   * Transaction nesting depth. `node:sqlite` has no transaction helper, so we
   * drive `BEGIN IMMEDIATE` ourselves and use SAVEPOINTs for nested calls
   * (better-sqlite3 did this automatically). 0 = no transaction open.
   */
  private txnDepth = 0;

  constructor(db: DatabaseSync) {
    this.raw = db;
  }

  exec(sql: string, params?: BindParams): ExecResult {
    const stmt = this.raw.prepare(sql);
    // `columns()` returns [] for non-row statements (INSERT/UPDATE/DDL) and the
    // result columns for SELECT / INSERT…RETURNING — a reliable discriminator.
    const cols = stmt.columns();
    if (cols.length === 0) {
      stmt.run(...(params ?? []));
      return [];
    }
    stmt.setReturnArrays(true); // rows as positional arrays (the `.raw()` shape)
    // node:sqlite's types don't model setReturnArrays() flipping the row shape
    // to arrays, so cast through `unknown`.
    const values = stmt.all(...(params ?? [])) as unknown as SqlValue[][];
    return values.length > 0
      ? [{ columns: cols.map((c) => c.name as string), values }]
      : [];
  }

  run(sql: string, params?: BindParams): void {
    if (params !== undefined) {
      this.raw.prepare(sql).run(...params);
      return;
    }
    // No params: may be a multi-statement script (migrations) or a bare
    // statement (BEGIN/COMMIT/PRAGMA). `exec` handles both.
    this.raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.txnDepth > 0 ? this.runNested(fn) : this.runOuter(fn);
  }

  /**
   * Nested call: a SAVEPOINT within the outer transaction's write lock. No
   * busy-retry — the outer transaction already holds the lock. The savepoint
   * lets the inner block roll back independently while the outer continues.
   */
  private runNested<T>(fn: () => T): T {
    const name = savepointName(this.txnDepth);
    this.raw.exec(`SAVEPOINT ${name}`);
    this.txnDepth++;
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      try {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
      } catch {
        // best-effort unwind
      }
      throw e;
    } finally {
      this.txnDepth--;
    }
  }

  /**
   * Outer transaction: `BEGIN IMMEDIATE` acquires the write lock up front so
   * cross-process writers serialize cleanly under WAL instead of failing late
   * on upgrade. `busy_timeout` covers most contention; a bounded synchronous
   * retry absorbs the residual SQLITE_BUSY (another connection holds the lock
   * past the timeout, or BUSY_SNAPSHOT). Non-busy errors and the final attempt
   * re-throw so genuine failures propagate.
   */
  private runOuter<T>(fn: () => T): T {
    for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
      try {
        return this.runOnce(fn);
      } catch (e) {
        if (!isBusyError(e) || attempt === BUSY_RETRY_ATTEMPTS - 1) throw e;
        sleepSync(BUSY_RETRY_BACKOFF_MS);
      }
    }
    // Unreachable: the loop returns on success or throws on the final attempt.
    throw new Error("transaction retry budget exhausted");
  }

  /** One `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` lifecycle. */
  private runOnce<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE"); // busy here propagates with no open txn
    this.txnDepth = 1;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // already rolled back / never began
      }
      throw e;
    } finally {
      this.txnDepth = 0;
    }
  }

  pragma(source: string): unknown {
    // node:sqlite has no `pragma()`; route through `exec`. OCR's pragmas are
    // all set-style (journal_mode, foreign_keys, busy_timeout, synchronous,
    // wal_checkpoint) and callers ignore the return value.
    this.raw.exec(`PRAGMA ${source}`);
    return undefined;
  }

  close(): void {
    try {
      this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // best-effort — never block close on a checkpoint failure
    }
    try {
      this.raw.close();
    } catch (e) {
      // Idempotent close: node:sqlite throws "database is not open" on a
      // double-close (better-sqlite3 was a no-op) — a cached connection can be
      // closed directly, then closed again by closeAllDatabases(). Swallow ONLY
      // that; any other close failure (corruption, permissions) must surface.
      const message = (e as Error | null)?.message ?? "";
      if (!/database is not open/i.test(message)) throw e;
    }
  }
}

/**
 * Probe that the SQLite engine loads and runs. Used by `ocr doctor` to confirm
 * the storage engine is healthy. With `node:sqlite` there is no native binary
 * to locate — this effectively verifies the runtime provides `node:sqlite`.
 */
export function probeEngine():
  | { ok: true; version: string }
  | { ok: false; error: string } {
  try {
    const db = newDatabase(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE _probe(x); INSERT INTO _probe VALUES (1);");
    const row = db.prepare("SELECT sqlite_version() AS v").get() as {
      v: string;
    };
    db.close();
    return { ok: true, version: row.v };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Open (or create) a `node:sqlite` connection at `dbPath` with OCR's standard
 * pragmas applied, wrapped in the adapter.
 */
export function openEngine(dbPath: string): Database {
  const native = newDatabase(dbPath);
  native.exec("PRAGMA journal_mode = WAL");
  native.exec("PRAGMA foreign_keys = ON");
  native.exec("PRAGMA busy_timeout = 5000");
  native.exec("PRAGMA synchronous = NORMAL");
  return new NodeSqliteAdapter(native);
}
