/**
 * SQLite engine adapter — backs OCR's database access with `better-sqlite3`
 * (native, on-disk, WAL) while preserving the small subset of the legacy
 * `sql.js` surface the codebase already uses (`exec`, `run`, `close`). This
 * bounds the migration blast radius: the ~100 existing query call sites that
 * call `db.exec(sql, params)` / `db.run(sql, params)` keep working unchanged.
 *
 * New code (event-sourced projection, atomic commands) SHOULD prefer the
 * native primitives exposed here — `prepare()`, `transaction()`, `pragma()`,
 * and the `raw` handle — which give real prepared statements and
 * cross-process-safe transactions.
 */

import BetterSqlite3 from "better-sqlite3";
import type { Database as BetterSqliteDatabase, Statement } from "better-sqlite3";

/** A value that can be bound to a parameter or returned from a column. */
export type SqlValue = number | string | bigint | Buffer | Uint8Array | null;

/** Positional bind parameters for `exec`/`run`. */
export type BindParams = ReadonlyArray<SqlValue>;

/**
 * Mirror of a `sql.js` `exec()` result set: an array (one entry per
 * row-returning statement) of `{columns, values}`. The codebase only ever
 * runs single statements through `exec`, so this array has length 0 (no
 * rows) or 1 (rows present), matching `sql.js` semantics so
 * `resultToRows`/`resultToRow` continue to work verbatim.
 */
export interface ExecResultRow {
  columns: string[];
  values: SqlValue[][];
}
export type ExecResult = ExecResultRow[];

/**
 * The OCR database handle. Replaces the `sql.js` `Database` type across the
 * codebase. Method shapes for `exec`/`run`/`close` match the legacy surface;
 * `prepare`/`transaction`/`pragma`/`raw` are the native additions.
 */
export interface Database {
  /**
   * Run a single SQL statement and return its rows in `sql.js` shape.
   * Returns `[]` when the statement returns no rows (matching `sql.js`).
   */
  exec(sql: string, params?: BindParams): ExecResult;
  /**
   * Execute a statement (or, when no params are given, one-or-more
   * statements — used by the migration runner) for its side effects.
   */
  run(sql: string, params?: BindParams): void;
  /** Prepare a single statement for repeated/typed execution. */
  prepare(sql: string): Statement;
  /** Run `fn` inside a single IMMEDIATE transaction (all-or-nothing). */
  transaction<T>(fn: () => T): T;
  /** Issue a PRAGMA against the underlying connection. */
  pragma(source: string): unknown;
  /** Escape hatch to the underlying better-sqlite3 handle. */
  readonly raw: BetterSqliteDatabase;
  /** Checkpoint the WAL and close the connection. */
  close(): void;
}

class BetterSqliteAdapter implements Database {
  readonly raw: BetterSqliteDatabase;

  constructor(db: BetterSqliteDatabase) {
    this.raw = db;
  }

  exec(sql: string, params?: BindParams): ExecResult {
    const stmt = this.raw.prepare(sql);
    if (!stmt.reader) {
      // Non-row-returning statement invoked via exec — run for side effects.
      stmt.run(...(params ?? []));
      return [];
    }
    const columns = stmt.columns().map((c) => c.name);
    const values = stmt.raw().all(...(params ?? [])) as SqlValue[][];
    return values.length > 0 ? [{ columns, values }] : [];
  }

  run(sql: string, params?: BindParams): void {
    if (params !== undefined) {
      this.raw.prepare(sql).run(...params);
      return;
    }
    // No params: may be a multi-statement script (migrations) or a bare
    // statement (BEGIN/COMMIT/PRAGMA). `better-sqlite3.exec` handles both.
    this.raw.exec(sql);
  }

  prepare(sql: string): Statement {
    return this.raw.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    // `immediate` acquires the write lock up front so cross-process writers
    // serialize cleanly under WAL instead of failing late on upgrade.
    return this.raw.transaction(fn).immediate();
  }

  pragma(source: string): unknown {
    return this.raw.pragma(source);
  }

  close(): void {
    try {
      this.raw.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // best-effort — never block close on a checkpoint failure
    }
    this.raw.close();
  }
}

/**
 * Probe that the native `better-sqlite3` binding loads and runs on this
 * platform. Used by `ocr doctor` to give a clear diagnostic instead of an
 * opaque crash when the prebuilt binary is missing or incompatible.
 */
export function probeEngine():
  | { ok: true; version: string }
  | { ok: false; error: string } {
  try {
    const db = new BetterSqlite3(":memory:");
    db.pragma("journal_mode = WAL");
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
 * Open (or create) a better-sqlite3 connection at `dbPath` with OCR's
 * standard pragmas applied, wrapped in the adapter.
 */
export function openEngine(dbPath: string): Database {
  const native = new BetterSqlite3(dbPath);
  native.pragma("journal_mode = WAL");
  native.pragma("foreign_keys = ON");
  native.pragma("busy_timeout = 5000");
  native.pragma("synchronous = NORMAL");
  return new BetterSqliteAdapter(native);
}
