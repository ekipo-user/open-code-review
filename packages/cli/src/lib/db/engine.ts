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
 * Requires Node >= 22.5 (when `node:sqlite` landed). The CLI entry guards the
 * Node version before this module loads, so a too-old runtime gets a clear
 * message rather than a `Cannot find module 'node:sqlite'` stack.
 */

import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";

// Load `node:sqlite` LAZILY (synchronous `require`, not a static import) so that
// importing this module does NOT touch the built-in. The CLI entry runs a
// Node-version guard and the experimental-warning filter first; deferring the
// load means a Node < 22.5 runtime gets a clear message instead of a hard
// `Cannot find module 'node:sqlite'` at import time, and the experimental
// warning is suppressed before it ever fires. Named `nodeRequire` to avoid
// colliding with the `require` the bundle banner defines.
const nodeRequire = createRequire(import.meta.url);
let _DatabaseSyncCtor: { new (path: string): DatabaseSync } | undefined;
function newDatabase(path: string): DatabaseSync {
  if (!_DatabaseSyncCtor) {
    _DatabaseSyncCtor = (
      nodeRequire("node:sqlite") as typeof import("node:sqlite")
    ).DatabaseSync;
  }
  return new _DatabaseSyncCtor(path);
}

/** A value that can be bound to a parameter or returned from a column. */
export type SqlValue = number | string | bigint | Buffer | Uint8Array | null;

/** Bounded retry budget for write transactions that hit SQLITE_BUSY. */
const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_BACKOFF_MS = 50;

/**
 * True when `e` is a `node:sqlite` lock-contention error. `node:sqlite`
 * surfaces the generic `code === "ERR_SQLITE_ERROR"` and puts the SQLite
 * primary result code in `errcode` (5 = SQLITE_BUSY, 261 = SQLITE_BUSY_SNAPSHOT).
 * Keying on `errcode` is load-bearing: get it wrong and the busy-retry loop
 * silently never fires under contention.
 */
export function isBusyError(e: unknown): boolean {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  return errcode === 5 || errcode === 261;
}

/**
 * Block the current thread for `ms` milliseconds. Synchronous because
 * `transaction()` is synchronous — we cannot `await` a timer mid-transaction.
 * Uses `Atomics.wait` on a throwaway SharedArrayBuffer, which parks the
 * thread without busy-spinning the CPU.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
 * legacy surface; `prepare`/`transaction`/`pragma`/`raw` are native additions.
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
  /** Escape hatch to the underlying node:sqlite handle. */
  readonly raw: DatabaseSync;
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
    const values = stmt.all(...(params ?? [])) as SqlValue[][];
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
    // Nested call: a SAVEPOINT within the outer transaction's write lock. No
    // busy-retry here — the outer transaction already holds the lock.
    if (this.txnDepth > 0) {
      const name = `ocr_sp_${this.txnDepth}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      this.txnDepth++;
      try {
        const result = fn();
        this.raw.exec(`RELEASE ${name}`);
        this.txnDepth--;
        return result;
      } catch (e) {
        try {
          this.raw.exec(`ROLLBACK TO ${name}`);
          this.raw.exec(`RELEASE ${name}`);
        } catch {
          // best-effort unwind
        }
        this.txnDepth--;
        throw e;
      }
    }

    // Outer transaction. `BEGIN IMMEDIATE` acquires the write lock up front so
    // cross-process writers serialize cleanly under WAL instead of failing late
    // on upgrade. `busy_timeout` covers most contention; a bounded synchronous
    // retry absorbs the residual SQLITE_BUSY (e.g. another connection holds the
    // lock past the timeout, or BUSY_SNAPSHOT). Non-busy errors and the final
    // attempt re-throw so genuine failures propagate.
    for (let attempt = 0; ; attempt++) {
      try {
        this.raw.exec("BEGIN IMMEDIATE");
        this.txnDepth = 1;
        try {
          const result = fn();
          this.raw.exec("COMMIT");
          this.txnDepth = 0;
          return result;
        } catch (inner) {
          try {
            this.raw.exec("ROLLBACK");
          } catch {
            // already rolled back / never began
          }
          this.txnDepth = 0;
          throw inner;
        }
      } catch (e) {
        if (!isBusyError(e) || attempt >= BUSY_RETRY_ATTEMPTS - 1) throw e;
        sleepSync(BUSY_RETRY_BACKOFF_MS);
      }
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
    } catch {
      // Idempotent close: node:sqlite throws "database is not open" on a
      // double-close, where better-sqlite3 was a no-op. A connection can be
      // closed directly yet still sit in the connection cache, so a later
      // closeAll() must not throw on the second close.
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
