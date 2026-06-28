/**
 * `ocr team resolve --team` end-to-end (Khorikov-classical).
 *
 * Spawns the built OCR binary as a real subprocess against a real `.ocr/`
 * workspace — no mocks, no internal imports. Proves the wiring that broke in
 * production: the AI passes the user's `--team` review override through to
 * `ocr team resolve --team "<spec>"`, and the CLI (not the AI) resolves it.
 * The shorthand parser itself is unit-tested in @open-code-review/config; these
 * tests cover the flag → parse → resolve → JSON path through the actual command.
 */

import { describe, it, expect, afterAll } from "vitest";
import { spawnCli } from "./helpers/spawn-cli.js";
import {
  createInitializedProject,
  writeConfigYaml,
  type TempProject,
} from "./helpers/temp-project.js";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((fn) => fn()));

function tracked<T extends TempProject>(project: T): T {
  cleanups.push(project.cleanup);
  return project;
}

interface ResolvedInstance {
  persona: string;
  instance_index: number;
  name: string;
  model: string | null;
}

describe("ocr team resolve --team", () => {
  it("replaces default_team with the spec, including custom personas, and applies the default model", async () => {
    // default_team is principal:2 / quality:2 with a workspace default model —
    // the exact archstack-ai shape. The --team override below reduces the
    // counts and adds personas absent from default_team (architect is custom
    // here, infrastructure is project-local).
    const project = tracked(createInitializedProject());
    writeConfigYaml(
      project,
      [
        "models:",
        "  default: big",
        "  aliases:",
        "    big: claude-opus-4-7",
        "default_team:",
        "  principal: 2",
        "  quality: 2",
        "",
      ].join("\n"),
    );

    const result = await spawnCli(
      [
        "team",
        "resolve",
        "--team",
        "principal:1,architect:1,infrastructure:1",
        "--json",
      ],
      { cwd: project.dir },
    );

    expect(result.exitCode).toBe(0);
    const resolved = JSON.parse(result.stdout) as ResolvedInstance[];

    // quality is gone (replaced wholesale); principal dropped 2 -> 1; the two
    // personas that were never in default_team are present.
    expect(resolved.map((r) => r.name)).toEqual([
      "principal-1",
      "architect-1",
      "infrastructure-1",
    ]);
    // The workspace default model (alias-expanded) flows through every instance.
    expect(resolved.every((r) => r.model === "claude-opus-4-7")).toBe(true);
  });

  it("rejects a malformed spec with exit 1 and a precise error, emitting no JSON", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    // Missing the required :count — the strict schema must reject, not coerce.
    const result = await spawnCli(
      ["team", "resolve", "--team", "principal", "--json"],
      { cwd: project.dir },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/:count is required/);
    expect(result.stdout.trim()).toBe("");
  });
});
