/**
 * Repo invariant: the browser-consumed `@open-code-review/platform` subpaths
 * (`/verdict`, `/counts`) are Node-free — neither their entry module nor any
 * module they transitively import may reference a `node:*` built-in.
 *
 * Why: the dashboard CLIENT imports these helpers (verdict normalization,
 * round-count derivation). The package BARREL legitimately pulls in
 * `node:url`/`node:child_process` for the spawn/liveness runtime, so a client
 * that imports a Node-free symbol from the barrel would drag Node built-ins into
 * the Vite bundle and crash it. The fix is the dedicated subpaths — and this
 * test pins that they stay Node-free as the modules evolve (the repo has no lint
 * toolchain, so the invariant lives as a test that runs on every OS in CI).
 *
 * Detection follows the transitive closure of RELATIVE imports from each subpath
 * entry and asserts no `from "node:…"` / `require("node:…")` value-use appears
 * anywhere in it. Type-only imports are erased at runtime and allowed.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = resolve(import.meta.dirname, "..");

/** Browser-consumed subpath entry files (must mirror package.json `exports`). */
const NODE_FREE_ENTRIES = ["verdict.ts", "counts.ts"];

/** A `node:*` value import/require/dynamic-import (not type-only). */
const NODE_BUILTIN_SHAPES = [
  /^[ \t]*import\s+(?!type\s)[^;\n]*from\s+['"]node:[^'"]+['"]/m,
  /^[ \t]*export\s+(?!type\s)[^;\n]*from\s+['"]node:[^'"]+['"]/m,
  /\brequire\(\s*['"]node:[^'"]+['"]\s*\)/,
  /\bimport\(\s*['"]node:[^'"]+['"]\s*\)/,
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Relative import specifiers (`./x`, `../y`) declared in a source string. */
function relativeImports(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) specs.push(m[1]!);
  return specs;
}

function resolveTs(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  // Entries are authored as `.ts`; tolerate `.js` specifiers (ESM convention).
  return base.endsWith(".ts") ? base : `${base.replace(/\.js$/, "")}.ts`;
}

/** Transitive closure of a subpath entry over its relative imports. */
function closure(entryFile: string): string[] {
  const seen = new Set<string>();
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue; // unresolved (e.g. .d.ts-only) — not our concern
    }
    for (const spec of relativeImports(stripComments(src))) {
      stack.push(resolveTs(file, spec));
    }
  }
  return [...seen];
}

describe("platform browser subpaths are Node-free", () => {
  it.each(NODE_FREE_ENTRIES)("%s and its transitive imports use no node:* builtins", (entry) => {
    const offenders: string[] = [];
    for (const file of closure(resolve(SRC, entry))) {
      const content = stripComments(readFileSync(file, "utf-8"));
      if (NODE_BUILTIN_SHAPES.some((re) => re.test(content))) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Node-free subpath '${entry}' transitively imports a node:* builtin — the dashboard ` +
        `browser bundle would break. Keep Node-coupled symbols out of this closure:\n` +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("detects a node: import (negative control)", () => {
    expect(NODE_BUILTIN_SHAPES.some((re) => re.test(`import { readFileSync } from "node:fs"`))).toBe(true);
    expect(NODE_BUILTIN_SHAPES.some((re) => re.test(`import type { URL } from "node:url"`))).toBe(false);
  });
});
