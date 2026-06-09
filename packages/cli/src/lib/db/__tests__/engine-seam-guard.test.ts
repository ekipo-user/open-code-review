/**
 * Architecture invariant: the SQLite engine has exactly ONE seam.
 *
 * The whole node:sqlite migration was only tractable because every consumer
 * goes through the `Database` adapter in `db/engine.ts` (~100 call sites,
 * the dashboard, the agent journal — all untouched). This guard turns that
 * "engine.ts is the only seam" property from convention into a structural
 * check (there is no ESLint config in this repo, so it lives as a test —
 * the same shape as `no-direct-lifecycle-writes`).
 *
 * It fails if a new file imports `node:sqlite` outside `db/engine.ts`, or if
 * `better-sqlite3` (the retired native engine) reappears anywhere.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → db → lib → src → cli → packages
const cliSrc = dirname(dirname(dirname(here)));
const packagesRoot = dirname(dirname(cliSrc));
const dashboardSrc = join(packagesRoot, "dashboard", "src");

/** The ONE file allowed to load node:sqlite (relative to packages/). */
const NODE_SQLITE_OWNER = join("cli", "src", "lib", "db", "engine.ts");

// Match IMPORT shapes only (not comments) — engine.ts keeps valuable historical
// references to better-sqlite3 in its comments, and tests legitimately load
// node:sqlite directly (the cross-process child script), so __tests__ is skipped.
const NODE_SQLITE = /(?:from|require\(|import\()\s*["']node:sqlite["']/;
const BETTER_SQLITE3 = /(?:from|require\(|import\()\s*["']better-sqlite3["']/;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir may not exist in a partial checkout
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") {
        continue;
      }
      out.push(...collectTsFiles(full));
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = [...collectTsFiles(cliSrc), ...collectTsFiles(dashboardSrc)];

describe("engine seam invariant", () => {
  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("only db/engine.ts imports node:sqlite", () => {
    const offenders = files.filter((f) => {
      const rel = relative(packagesRoot, f);
      if (rel.split(sep).join(sep) === NODE_SQLITE_OWNER) return false;
      return NODE_SQLITE.test(readFileSync(f, "utf8"));
    });
    expect(offenders.map((f) => relative(packagesRoot, f))).toEqual([]);
  });

  it("no source references the retired better-sqlite3 engine", () => {
    const offenders = files.filter((f) => BETTER_SQLITE3.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(packagesRoot, f))).toEqual([]);
  });
});
