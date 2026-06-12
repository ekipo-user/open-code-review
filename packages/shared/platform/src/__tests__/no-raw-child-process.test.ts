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
 * Type-only imports are fine (erased at runtime). Test files and the e2e
 * harnesses are exempt: they spawn the system under test by design.
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

/**
 * A child_process import that binds VALUES (not `import type {...}`).
 * Single-line scoped (`[^;\n]*`) — the dashboard's semicolon-free style
 * would otherwise let the match span unrelated import statements.
 * Multi-line named-import lists are normalized before matching.
 */
const VALUE_IMPORT = /^import\s+(?!type\s)[^;\n]*from\s+['"](node:)?child_process['"]/m;
/** `import { type X, type Y } from ...` — every named binding type-only. */
function isAllTypeBindings(line: string): boolean {
  const m = line.match(/import\s*\{([^}]*)\}/);
  if (!m) return false;
  return m[1]!
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean)
    .every((b) => b.startsWith("type "));
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
        const content = readFileSync(file, "utf-8");
        // Collapse multi-line braced lists so `import {\n  spawn,\n} from …`
        // becomes single-line and the line-scoped regex sees it.
        const normalized = content.replace(/\{[\s\S]*?\}/g, (block) =>
          block.replace(/\s+/g, " "),
        );
        const match = normalized.match(VALUE_IMPORT);
        if (match && !isAllTypeBindings(match[0])) {
          violations.push(relFile);
        }
      }
    }
    expect(
      violations,
      `Raw child_process import(s) found — use execBinary/execBinaryAsync/spawnBinary ` +
        `from @open-code-review/platform instead (Windows .cmd resolution + argv safety):\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    ).toEqual([]);
  });
});
