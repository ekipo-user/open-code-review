/**
 * Architecture invariant: single-writer lifecycle (CLI side).
 *
 * Mirror of the dashboard's `no-direct-lifecycle-writes` guard, scoped to the
 * CLI. The CLI legitimately OWNS lifecycle writes, so — unlike the dashboard,
 * which is forbidden from ALL of them — this guard pins the CLOSE path to its
 * single writer instead of banning lifecycle SQL outright.
 *
 * SCOPING DECISION (the instruction offered two framings; this is why this
 * one was chosen). The status→closed transition in the CLI is NEVER emitted as
 * a literal `UPDATE sessions SET ... status = 'closed'` SQL string. It is
 * expressed structurally: callers pass `{ status: "closed" }` into the
 * `commitReasonClose` primitive (db/queries.ts), which threads it to
 * `updateSession` (db/queries.ts), the ONE function that builds the raw
 * `UPDATE sessions SET ...` string. So "status-close writes live only in
 * queries.ts via commitReasonClose" is the precise, real invariant, and that
 * is what this test enforces:
 *
 *   - The raw `UPDATE sessions SET ...` SQL string (the only place a status
 *     column can actually be written) lives ONLY in db/queries.ts.
 *   - `INSERT INTO sessions` (row creation) likewise lives ONLY in
 *     db/queries.ts.
 *   - state/index.ts (`stateClose`/`stateInit`) and the other porcelain
 *     callers legitimately PASS `{ status: "closed" }` but never emit raw SQL —
 *     they route through the queries.ts primitive, which is the property that
 *     keeps the close path single-writer.
 *
 * This fails if a NEW file introduces an ad-hoc raw `UPDATE sessions SET status`
 * (or `INSERT INTO sessions`) write outside queries.ts — exactly the regression
 * that would let a status flip dodge `commitReasonClose` and the close-guard
 * trigger.
 *
 * Uses the same node:fs recursive-walk approach as the dashboard guard.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → db → lib
const libRoot = dirname(dirname(here));

/**
 * Files allowed to contain the raw lifecycle-write SQL. db/queries.ts is the
 * single low-level writer (insertSession / updateSession / commitReasonClose);
 * every other module routes through it.
 */
const ALLOWED_RELATIVE = new Set<string>(["db/queries.ts"]);

/**
 * Forbidden ad-hoc lifecycle write shapes when they appear OUTSIDE the allowed
 * files. The `status` regex matches `status` ANYWHERE in the SET list (not just
 * the first column) and tolerates a table alias (`UPDATE sessions AS s SET`),
 * so a column-reordering or aliasing dodge can't slip an ad-hoc status write
 * past the guard. It still does NOT match a SET list that never mentions
 * `status`.
 */
const FORBIDDEN_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: "INSERT INTO sessions", regex: /INSERT\s+INTO\s+sessions\b/i },
  {
    label: "REPLACE INTO sessions",
    regex: /(?:INSERT\s+OR\s+)?REPLACE\s+INTO\s+sessions\b/i,
  },
  // `[^;]*?` keeps the match on the same statement so it can't reach across a
  // `;` into an unrelated query.
  {
    label: "UPDATE sessions SET status",
    regex: /UPDATE\s+sessions\b(?:\s+AS\s+\w+)?\s+SET\s+[^;]*?\bstatus\b/i,
  },
];

/** Recursively collect every .ts file under `dir`, excluding __tests__ trees. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...collectTsFiles(full));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Normalize an absolute path to a `/`-joined path relative to lib/. */
function relToLib(file: string): string {
  return relative(libRoot, file).split(sep).join("/");
}

const byLabel = (label: string): RegExp =>
  FORBIDDEN_PATTERNS.find((p) => p.label === label)!.regex;

describe("single-writer lifecycle invariant (CLI)", () => {
  const files = collectTsFiles(libRoot);

  it("scans a non-trivial number of CLI lib source files", () => {
    // Sanity check the walk found the lib tree — guards against a
    // silently-empty scan giving a false-green result.
    expect(files.length).toBeGreaterThan(10);
  });

  it("includes the allowed single-writer module in the scanned set", () => {
    // If queries.ts were renamed/moved, ALLOWED_RELATIVE would be stale and
    // the guard could silently stop protecting the real writer. Pin it.
    const scanned = new Set(files.map(relToLib));
    for (const allowed of ALLOWED_RELATIVE) {
      expect(scanned.has(allowed)).toBe(true);
    }
  });

  it("confines raw lifecycle-write SQL to db/queries.ts (the single writer)", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relToLib(file);
      if (ALLOWED_RELATIVE.has(rel)) continue;
      const src = readFileSync(file, "utf-8");
      for (const { label, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(src)) {
          violations.push(`${label} found in ${rel}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("verifies the allowed writer actually owns the session-row writes", () => {
    // The whole point of confining the writes to queries.ts is that they live
    // there. If they ever move out, this fails and forces ALLOWED_RELATIVE (and
    // the rationale above) to be re-examined.
    //
    // `INSERT INTO sessions` is a static string in `insertSession`, so the
    // forbidden-pattern regex matches it directly. The status write, by
    // contrast, is built dynamically — `updateSession` assembles
    // `UPDATE sessions SET ${setClauses.join(", ")}` and pushes a separate
    // `status = ?` clause — so there is no contiguous `UPDATE sessions SET
    // status` substring to match. We assert the two structural fragments
    // (the UPDATE template and the status clause-builder) both live here
    // instead; that is the real shape of the single writer.
    const queriesFile = files.find((f) => relToLib(f) === "db/queries.ts");
    expect(queriesFile).toBeDefined();
    const src = readFileSync(queriesFile!, "utf-8");
    expect(byLabel("INSERT INTO sessions").test(src)).toBe(true);
    expect(/UPDATE\s+sessions\s+SET\b/i.test(src)).toBe(true);
    expect(/["']status\s*=\s*\?["']/.test(src)).toBe(true);
  });
});

/**
 * Positive self-tests for the guard's regexes. The confinement scan above is
 * only as strong as the regexes; a future "simplification" that weakens a
 * pattern would silently make the scan vacuously green. These tests pin each
 * regex against KNOWN-BAD strings it MUST flag (and one known-GOOD string the
 * status regex must NOT flag), so a regex regression fails here loudly.
 */
describe("forbidden-write regexes flag known-bad SQL (regex self-test)", () => {
  it("status regex matches status anywhere in the SET list", () => {
    expect(
      byLabel("UPDATE sessions SET status").test(
        "UPDATE sessions SET current_phase='x', status='closed' WHERE id=?",
      ),
    ).toBe(true);
  });

  it("status regex matches an aliased sessions table", () => {
    expect(
      byLabel("UPDATE sessions SET status").test(
        "UPDATE sessions AS s SET status='closed'",
      ),
    ).toBe(true);
  });

  it("status regex matches status as the first SET column", () => {
    expect(
      byLabel("UPDATE sessions SET status").test(
        "UPDATE sessions SET status='closed' WHERE id=?",
      ),
    ).toBe(true);
  });

  it("REPLACE regex matches REPLACE INTO sessions", () => {
    expect(
      byLabel("REPLACE INTO sessions").test("REPLACE INTO sessions (id) VALUES (?)"),
    ).toBe(true);
  });

  it("REPLACE regex matches INSERT OR REPLACE INTO sessions", () => {
    expect(
      byLabel("REPLACE INTO sessions").test(
        "INSERT OR REPLACE INTO sessions (id) VALUES (?)",
      ),
    ).toBe(true);
  });

  it("INSERT regex matches INSERT INTO sessions", () => {
    expect(
      byLabel("INSERT INTO sessions").test("INSERT INTO sessions (id) VALUES (?)"),
    ).toBe(true);
  });

  it("tolerates the benign projection round/run sync (status regex must not over-match)", () => {
    // The allowed pointer-sync write touches current_round / current_map_run
    // but never `status`; the status regex must NOT flag it.
    const benign =
      "UPDATE sessions SET current_round = ?, current_map_run = ?, updated_at = datetime('now') WHERE id = ?";
    expect(byLabel("UPDATE sessions SET status").test(benign)).toBe(false);
  });
});
