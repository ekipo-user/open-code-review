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

beforeEach(async () => {
  tmpDir = makeTempWorkspace("ocr-v14-test-");
  db = await openDatabase(join(tmpDir, "ocr.db"));
  runMigrations(db);
});

afterEach(() => {
  if (tmpDir) removeTempWorkspace(tmpDir);
});

function count(sql: string): number {
  const r = db.exec(sql);
  return Number(r[0]?.values[0]?.[0] ?? 0);
}

/** Roll back v14 so we can re-apply it onto a pathological (duplicated) table. */
function regressToPreV14(): void {
  db.run("DROP INDEX IF EXISTS idx_markdown_artifacts_logical");
  db.run("DELETE FROM schema_version WHERE version >= 14");
}

describe("migration v14 — markdown_artifacts dedup + NULL-safe unique index", () => {
  it("collapses NULL-round duplicates to the newest row and survives re-runs", () => {
    db.run("INSERT INTO sessions (id, branch, status, workflow_type, session_dir) VALUES ('s1','b','active','review','.ocr/sessions/s1')");
    regressToPreV14();
    // The pre-v14 UNIQUE(session,type,round,path) does NOT dedup NULL rounds
    // (NULL ≠ NULL in SQLite), so three identical session-level rows coexist —
    // exactly the production pathology (one context.md had 775 copies).
    for (const c of ["v1", "v2", "v3-latest"]) {
      db.run(
        `INSERT INTO markdown_artifacts (session_id, artifact_type, round_number, file_path, content, parsed_at)
         VALUES ('s1','context',NULL,'s1/context.md',?, datetime('now'))`,
        [c],
      );
    }
    expect(count("SELECT COUNT(*) FROM markdown_artifacts")).toBe(3);

    runMigrations(db); // applies v14

    expect(count("SELECT COUNT(*) FROM markdown_artifacts")).toBe(1);
    const kept = db.exec("SELECT content FROM markdown_artifacts");
    expect(kept[0]!.values[0]![0]).toBe("v3-latest"); // newest (max rowid) wins

    // Idempotent — re-running the runner doesn't throw or change anything.
    expect(() => runMigrations(db)).not.toThrow();
    expect(count("SELECT COUNT(*) FROM markdown_artifacts")).toBe(1);
  });

  it("the NULL-safe unique index blocks a second NULL-round row for the same key", () => {
    db.run("INSERT INTO sessions (id, branch, status, workflow_type, session_dir) VALUES ('s2','b','active','review','.ocr/sessions/s2')");
    db.run(
      `INSERT INTO markdown_artifacts (session_id, artifact_type, round_number, file_path, content, parsed_at)
       VALUES ('s2','map',NULL,'s2/map.md','a', datetime('now'))`,
    );
    expect(() =>
      db.run(
        `INSERT INTO markdown_artifacts (session_id, artifact_type, round_number, file_path, content, parsed_at)
         VALUES ('s2','map',NULL,'s2/map.md','b', datetime('now'))`,
      ),
    ).toThrow(); // UNIQUE constraint (IFNULL(round_number,-1)) collapses NULL
    expect(count("SELECT COUNT(*) FROM markdown_artifacts WHERE session_id='s2'")).toBe(1);
  });
});
