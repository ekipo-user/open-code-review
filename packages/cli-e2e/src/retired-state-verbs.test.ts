/**
 * Retired `ocr state` verb regression (v2 cutover).
 *
 * The v2.0 cutover deleted the imperative state verbs
 * (`init` / `transition` / `round-complete` / `map-complete` / `close`) in
 * favor of the atomic porcelain (`begin` / `advance` / `complete-round` /
 * `complete-map` / `finish`). A v1-pinned agent (or operator) that still calls
 * a retired verb must get a DETERMINISTIC, machine-distinguishable signal —
 * typed exit 2 (USAGE) plus a message that names the replacement — rather than
 * commander's generic exit-1 "Did you mean ...?" guess.
 *
 * This is the end-to-end pin for that contract: it spawns the built CLI as a
 * real subprocess (no mocks) and asserts the retired-vs-valid boundary from the
 * outside, the way the agent actually experiences it.
 *
 * See `RETIRED_STATE_VERBS` + the `command:*` handler in
 * packages/cli/src/commands/state.ts.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawnCli } from "./helpers/spawn-cli.js";
import {
  createInitializedProject,
  type TempProject,
} from "./helpers/temp-project.js";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((fn) => fn()));

function tracked<T extends TempProject>(project: T): T {
  cleanups.push(project.cleanup);
  return project;
}

/**
 * The full retired verb → v2 replacement set, mirroring `RETIRED_STATE_VERBS`
 * in state.ts. Black-box e2e (no internal imports), so the mapping is declared
 * here; the production source is the authority. `close` → `finish` is the
 * highest-risk LLM idiom (most likely embedded in pre-trained prompts), so it
 * is pinned alongside the rest.
 */
const RETIRED: ReadonlyArray<readonly [verb: string, replacement: string]> = [
  ["init", "begin"],
  ["transition", "advance"],
  ["round-complete", "complete-round"],
  ["map-complete", "complete-map"],
  ["close", "finish"],
];

describe("retired `ocr state` verbs", () => {
  for (const [verb, replacement] of RETIRED) {
    it(`'ocr state ${verb}' exits 2 and names the replacement '${replacement}'`, async () => {
      const project = tracked(createInitializedProject());

      const result = await spawnCli(["state", verb], { cwd: project.dir });

      // Typed USAGE exit (2), distinct from commander's generic exit-1 path.
      expect(result.exitCode).toBe(2);

      // The retirement notice + replacement verb are surfaced to the caller.
      const combined = result.stderr + result.stdout;
      expect(combined).toContain("was retired in v2.0");
      expect(combined).toContain(replacement);
    });
  }

  it("a valid `ocr state` invocation does NOT exit 2 (retired-vs-valid boundary)", async () => {
    const project = tracked(createInitializedProject());

    // `state --help` is an unambiguously valid invocation: commander prints
    // help and exits 0. Pinning "not 2" here proves the exit-2 signal is
    // specific to the retired verbs, not a blanket `ocr state` failure.
    const result = await spawnCli(["state", "--help"], { cwd: project.dir });

    expect(result.exitCode).not.toBe(2);
    expect(result.stdout).toContain("begin");
    expect(result.stdout).toContain("advance");
  });
});
