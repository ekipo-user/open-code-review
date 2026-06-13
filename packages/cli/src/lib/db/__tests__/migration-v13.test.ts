import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openDatabase,
  runMigrations,
  type Database,
} from "../index.js";
import { makeTempWorkspace, removeTempWorkspace } from "../test-support.js";

let tmpDir: string;
let db: Database;

async function freshDb(): Promise<Database> {
  tmpDir = makeTempWorkspace("ocr-v13-test-");
  const conn = await openDatabase(join(tmpDir, "ocr.db"));
  runMigrations(conn); // applies all migrations, including v13
  return conn;
}

function columnNames(table: string): string[] {
  const r = db.exec(`PRAGMA table_info(${table})`);
  const nameIdx = r[0]!.columns.indexOf("name");
  return r[0]!.values.map((row) => row[nameIdx] as string);
}

/** Re-create a pre-v13 shape: add parent_id back and roll schema_version to 12. */
function regressToPreV13(): void {
  db.run(
    "ALTER TABLE command_executions ADD COLUMN parent_id INTEGER REFERENCES command_executions(id)",
  );
  db.run("DELETE FROM schema_version WHERE version >= 13");
}

beforeEach(async () => {
  db = await freshDb();
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
});

describe("migration v13 — DROP COLUMN parent_id", () => {
  it("leaves command_executions without parent_id after a normal upgrade", () => {
    expect(columnNames("command_executions")).not.toContain("parent_id");
  });

  it("drops parent_id when upgrading a pre-v13 database, and is idempotent across re-runs", () => {
    // Round 1: a real upgrade from a db that still has parent_id.
    regressToPreV13();
    expect(columnNames("command_executions")).toContain("parent_id");
    runMigrations(db);
    expect(columnNames("command_executions")).not.toContain("parent_id");

    // Round 2: do it again — re-add, roll back the version, re-upgrade.
    regressToPreV13();
    runMigrations(db);
    expect(columnNames("command_executions")).not.toContain("parent_id");
  });

  it("columnExists guard makes the DROP a clean no-op when parent_id is already gone", () => {
    // Roll the version back WITHOUT re-adding parent_id: v13's run(db) must see
    // the column is gone and skip the DROP rather than error on a missing column.
    db.run("DELETE FROM schema_version WHERE version >= 13");
    expect(columnNames("command_executions")).not.toContain("parent_id");
    expect(() => runMigrations(db)).not.toThrow();
    expect(columnNames("command_executions")).not.toContain("parent_id");
  });

  it("runs inside the migration runner's transaction (does not open its own)", () => {
    // The runner wraps each migration in BEGIN IMMEDIATE. If v13's run(db)
    // started its own transaction, the nested BEGIN would throw 'cannot start a
    // transaction within a transaction'. A clean re-upgrade proves it doesn't.
    regressToPreV13();
    expect(() => runMigrations(db)).not.toThrow();
    const version = db.exec("SELECT MAX(version) FROM schema_version");
    // The runner applies all pending migrations; assert it reached the latest
    // (>= 13) rather than pinning a number that every new migration breaks.
    expect(Number(version[0]!.values[0]![0])).toBeGreaterThanOrEqual(13);
  });
});
