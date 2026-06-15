/**
 * Repo invariant: production code spawns processes ONLY through the
 * platform wrappers (issue #43).
 *
 * The wrappers own Windows `.cmd` shim resolution and argv safety; a raw
 * `child_process` import bypasses both — raw call sites were how
 * `ocr review --resume` and the dashboard's `ocr team set` invocation
 * were quietly Windows-broken, and how argv strings could regress into a
 * shell. The repo has no lint toolchain, so the invariant lives here as a
 * test (runs on every OS in CI) instead of an ESLint rule.
 *
 * The matcher catches every way a module can acquire `child_process` as a
 * VALUE — static import, re-export, `require()`, dynamic `import()`, and
 * `createRequire(...)(...)` — because `require()` is the most idiomatic
 * bypass in this repo (the CLI bundle's banner injects a working `require`
 * into every ESM output, and cross-spawn is itself CJS). Type-only imports
 * are fine (erased at runtime). The detection core is the exported, directly
 * unit-tested `findViolation` below, with positive controls proving each
 * shape is actually caught (issue #43 review, should-fix SF1 — the previous
 * regex only saw static `import` and had no self-test).
 *
 * Test files and the e2e harnesses are exempt: they spawn the system under
 * test by design.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

const SANCTIONED = [
  // The wrappers themselves (spawn.ts) and the reaping internals (ps /
  // taskkill — plain executables that need no shim resolution).
  join("packages", "shared", "platform", "src"),
  // e2e harnesses spawn the built system under test by design.
  join("packages", "cli-e2e", "src"),
  join("packages", "dashboard-api-e2e", "src"),
  join("packages", "dashboard-ui-e2e", "src"),
];

function srcRoots(): string[] {
  const roots: string[] = [];
  for (const base of ["packages", join("packages", "shared")]) {
    const baseAbs = join(REPO_ROOT, base);
    let entries: string[];
    try {
      entries = readdirSync(baseAbs);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const src = join(baseAbs, entry, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        /* no src dir */
      }
    }
  }
  return roots;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

// The module specifier, with or without the `node:` prefix, single or double
// quoted. Shared by every shape below.
const SPEC = String.raw`['"](?:node:)?child_process['"]`;

/**
 * Each detectable VALUE-acquisition shape. `typeOnlyExempt` shapes (the
 * `import`/`export … from` forms) may be type-only — those are erased at
 * runtime and allowed — so a positive match is re-checked with
 * {@link isAllTypeBindings}. `require`/dynamic-`import`/`createRequire` have no
 * type-only form: a match is always a runtime value use.
 */
const SHAPES: { name: string; re: RegExp; typeOnlyExempt: boolean }[] = [
  {
    name: "static import",
    re: new RegExp(String.raw`^[ \t]*import\s+(?!type\s)[^;\n]*from\s+${SPEC}`, "m"),
    typeOnlyExempt: true,
  },
  {
    name: "re-export",
    re: new RegExp(String.raw`^[ \t]*export\s+(?!type\s)[^;\n]*from\s+${SPEC}`, "m"),
    typeOnlyExempt: true,
  },
  { name: "require()", re: new RegExp(String.raw`\brequire\(\s*${SPEC}\s*\)`), typeOnlyExempt: false },
  { name: "dynamic import()", re: new RegExp(String.raw`\bimport\(\s*${SPEC}\s*\)`), typeOnlyExempt: false },
  {
    name: "createRequire()()",
    re: new RegExp(String.raw`createRequire\([^)]*\)\(\s*${SPEC}`),
    typeOnlyExempt: false,
  },
];

/** `import { type X, type Y } from ...` — every named binding type-only. */
function isAllTypeBindings(line: string): boolean {
  const m = line.match(/\{([^}]*)\}/);
  if (!m) return false; // default/namespace import of a value
  return m[1]!
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean)
    .every((b) => b.startsWith("type "));
}

/** Strip line + block comments so a documented example never trips the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Blank the CONTENTS of single- and double-quoted string literals so
 * code-shaped text living inside a string — e.g. `const tag =
 * "require('child_process')"` — can't trip a shape matcher. A literal whose
 * content is exactly the `child_process` module specifier is PRESERVED: that
 * string is the genuine acquisition target the SHAPES regexes key on
 * (`require('child_process')`, `from 'child_process'`), so blanking it would
 * erase the specifier from real call sites and the matcher would go blind.
 * (Template literals are out of scope — the matcher has never claimed them.)
 */
function stripStringLiterals(src: string): string {
  return src.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (lit) => {
    const inner = lit.slice(1, -1);
    if (/^(?:node:)?child_process$/.test(inner)) return lit;
    const quote = lit[0]!;
    return `${quote}${quote}`;
  });
}

/**
 * Find the first raw-`child_process` VALUE acquisition in a source string, or
 * `null` if the module only uses it type-only (or not at all). Exported for
 * direct unit testing (positive controls below).
 */
export function findViolation(source: string): { shape: string; matched: string } | null {
  // Strip comments first, then blank string-literal contents (a `{`/`}` inside
  // a string would otherwise confuse the brace-collapse below).
  const content = stripStringLiterals(stripComments(source));
  // Collapse multi-line braced lists so `import {\n  spawn,\n} from …` becomes
  // single-line and the line-scoped import/export regexes see it.
  const normalized = content.replace(/\{[\s\S]*?\}/g, (block) => block.replace(/\s+/g, " "));
  for (const shape of SHAPES) {
    const match = normalized.match(shape.re);
    if (!match) continue;
    if (shape.typeOnlyExempt && isAllTypeBindings(match[0])) continue;
    return { shape: shape.name, matched: match[0].trim() };
  }
  return null;
}

describe("no raw child_process outside the platform layer", () => {
  it("every production spawn goes through the platform wrappers", () => {
    const violations: string[] = [];
    for (const root of srcRoots()) {
      const rel = relative(REPO_ROOT, root);
      if (SANCTIONED.some((allowed) => rel === allowed)) continue;
      for (const file of walk(root)) {
        const relFile = relative(REPO_ROOT, file);
        if (relFile.includes(`${sep}__tests__${sep}`) || /\.test\.tsx?$/.test(relFile)) {
          continue;
        }
        const found = findViolation(readFileSync(file, "utf-8"));
        if (found) violations.push(`${relFile} (${found.shape})`);
      }
    }
    expect(
      violations,
      `Raw child_process value-use(s) found — use execBinary/execBinaryAsync/spawnBinary ` +
        `from @open-code-review/platform instead (Windows .cmd resolution + argv safety):\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    ).toEqual([]);
  });
});

describe("findViolation — positive controls (the matcher can actually fail)", () => {
  it.each([
    ["static default import", `import cp from 'child_process'`],
    ["static named import", `import { spawn } from 'node:child_process'`],
    ["static namespace import", `import * as cp from "child_process"`],
    ["multi-line named import", `import {\n  spawn,\n  execFile,\n} from 'child_process'`],
    ["re-export", `export { spawn } from 'node:child_process'`],
    ["require()", `const cp = require('child_process')`],
    ["require() node: prefix", `const { spawn } = require("node:child_process")`],
    ["dynamic import()", `const cp = await import('child_process')`],
    ["createRequire()()", `const cp = createRequire(import.meta.url)('child_process')`],
  ])("flags %s", (_shape, snippet) => {
    expect(findViolation(snippet)).not.toBeNull();
  });

  it.each([
    ["type-only import", `import type { ChildProcess } from 'node:child_process'`],
    ["inline type-only bindings", `import { type ChildProcess, type SpawnOptions } from 'child_process'`],
    ["type-only re-export", `export type { ChildProcess } from 'child_process'`],
    ["unrelated module", `import { readFileSync } from 'node:fs'`],
    ["child_process only in a comment", `// historically we used require('child_process') here\nimport { execBinary } from '@open-code-review/platform'`],
    ["child_process in a string literal", `const label = 'child_process'`],
    ["require() shape embedded in a string literal", `const tag = "require('child_process')"`],
    ["dynamic import() shape embedded in a string literal", `const doc = 'await import("child_process")'`],
    ["platform wrapper import", `import { spawnBinary } from '@open-code-review/platform'`],
  ])("does NOT flag %s", (_shape, snippet) => {
    expect(findViolation(snippet)).toBeNull();
  });
});
