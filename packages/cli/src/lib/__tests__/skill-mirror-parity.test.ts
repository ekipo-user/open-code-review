import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * The agent skills the LLM reads live in TWO trees that must stay in lockstep:
 *   - source: `packages/agents/skills/ocr/references/`
 *   - mirror: `.ocr/skills/references/` (this repo dogfoods its own install;
 *     regenerated from the source by `nx run cli:update`).
 * A direct edit to either tree silently desyncs the two LLM reading paths. This
 * guard fails CI on any drift so the desync can't ship.
 */

/** Walk up from `start` until the workspace root (has pnpm-workspace.yaml). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("workspace root (pnpm-workspace.yaml) not found");
}

/** Map of relative-path → file contents for every file under `dir`. */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(d, entry.name), rel);
      else out.set(rel, readFileSync(join(d, entry.name), "utf-8"));
    }
  };
  walk(dir, "");
  return out;
}

describe("agent skill mirror parity", () => {
  const root = findRepoRoot(import.meta.dirname);
  const source = join(root, "packages/agents/skills/ocr/references");
  const mirror = join(root, ".ocr/skills/references");

  it("the .ocr/ mirror is byte-identical to the packages/agents source (run `nx run cli:update` if this fails)", () => {
    const src = readTree(source);
    const mir = readTree(mirror);

    // Same set of files in both trees.
    expect([...mir.keys()].sort()).toEqual([...src.keys()].sort());

    // Same bytes for every file.
    for (const [name, content] of src) {
      expect(mir.get(name), `skill mirror drift in ${name}`).toBe(content);
    }
  });
});
