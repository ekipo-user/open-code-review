import { describe, it, expect, afterEach } from "vitest";
import { openEngine, isBusyError, type Database } from "../engine.js";

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

describe("isBusyError", () => {
  it("keys on node:sqlite's errcode (5 = BUSY, 261 = BUSY_SNAPSHOT)", () => {
    // node:sqlite puts the SQLite primary code in `errcode`; `code` is the
    // generic "ERR_SQLITE_ERROR". The retry loop fires only if this is right.
    expect(isBusyError({ errcode: 5 })).toBe(true);
    expect(isBusyError({ errcode: 261 })).toBe(true);
  });

  it("does not match non-busy errors or the legacy better-sqlite3 shape", () => {
    expect(isBusyError({ errcode: 1 })).toBe(false); // SQLITE_ERROR
    expect(isBusyError({ errcode: 19 })).toBe(false); // SQLITE_CONSTRAINT
    expect(isBusyError({ code: "SQLITE_BUSY" })).toBe(false); // old shape, gone
    expect(isBusyError(new Error("database is locked"))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });
});

describe("transaction (hand-rolled BEGIN IMMEDIATE + savepoint nesting)", () => {
  it("commits a nested transaction (both inner and outer persist)", () => {
    db = openEngine(":memory:");
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.transaction(() => {
      db!.run("INSERT INTO t (v) VALUES (?)", ["outer"]);
      db!.transaction(() => {
        db!.run("INSERT INTO t (v) VALUES (?)", ["inner"]);
      });
    });
    expect(db.exec("SELECT COUNT(*) AS n FROM t")[0]?.values[0]?.[0]).toBe(2);
  });

  it("rolls back only the inner savepoint when the nested tx throws, outer continues", () => {
    db = openEngine(":memory:");
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.transaction(() => {
      db!.run("INSERT INTO t (v) VALUES (?)", ["outer"]);
      try {
        db!.transaction(() => {
          db!.run("INSERT INTO t (v) VALUES (?)", ["inner-doomed"]);
          throw new Error("inner boom");
        });
      } catch {
        // savepoint rolled back; the outer transaction keeps going
      }
      db!.run("INSERT INTO t (v) VALUES (?)", ["outer-after"]);
    });
    const rows = db.exec("SELECT v FROM t ORDER BY id")[0]?.values.map((r) => r[0]);
    expect(rows).toEqual(["outer", "outer-after"]); // inner-doomed gone
  });

  it("rolls the whole transaction back when the outer body throws", () => {
    db = openEngine(":memory:");
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.run("INSERT INTO t (v) VALUES (?)", ["seed"]);
    expect(() =>
      db!.transaction(() => {
        db!.run("INSERT INTO t (v) VALUES (?)", ["doomed"]);
        throw new Error("outer boom");
      }),
    ).toThrow("outer boom");
    expect(db.exec("SELECT COUNT(*) AS n FROM t")[0]?.values[0]?.[0]).toBe(1);
  });
});
