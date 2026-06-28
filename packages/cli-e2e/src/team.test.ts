/**
 * `ocr team` end-to-end tests — team-indication permutations.
 *
 * Khorikov classical (Detroit) school:
 *   • Real subprocess execution of the built `ocr` binary
 *   • Real config.yaml on disk in a real temp `.ocr/` workspace
 *   • No internal-module imports, no internal mocks
 *
 * Tests assert observable behavior — exit codes, JSON/stdout, and on-disk
 * config — across every way a team can be INDICATED to a CLI team command.
 * There are exactly three CLI-resolvable sources, plus their composition:
 *
 *   1. DEFAULT team     — `ocr team resolve` reads `default_team` from config
 *                         (all three schema forms, aliases, workspace default).
 *   2. CUSTOM team      — `--team reviewer-id:count,...` REPLACES `default_team`
 *                         wholesale (a subset of the default = "minus", a
 *                         superset = "plus", or a wholly different roster).
 *   3. SESSION override — `--session-override <json>` (the dashboard path)
 *                         MERGES onto the base: add a persona, grow or shrink a
 *                         persona's instance count, or swap its model.
 *   …and the two composed: a `--team` base with a `--session-override` merge.
 *
 * Ephemeral `--reviewer` additions are intentionally NOT covered here: they are
 * synthesized and spawned by the orchestrating agent and never reach a CLI team
 * command, so there is no binary behavior to assert. The roster the agent
 * ultimately spawns is (this resolved list) + (agent-side ephemeral personas).
 * The exhaustive `--team` grammar rejections live in the @open-code-review/config
 * unit suite; here we assert the command's wiring and one representative error
 * per distinct failure path.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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

/** Resolve a team through the real binary, asserting a clean JSON exit. */
async function resolveTeam(
  project: TempProject,
  args: string[] = [],
  opts?: { stdin?: string },
): Promise<ResolvedInstance[]> {
  const result = await spawnCli(["team", "resolve", "--json", ...args], {
    cwd: project.dir,
    stdin: opts?.stdin,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ResolvedInstance[];
}

const personaCount = (team: ResolvedInstance[], persona: string): number =>
  team.filter((i) => i.persona === persona).length;

// ── 1. DEFAULT team: `ocr team resolve` reads default_team from config ──

describe("ocr team resolve — default team (from .ocr/config.yaml)", () => {
  it("returns an empty array when default_team is absent", async () => {
    const project = tracked(createInitializedProject());
    expect(await resolveTeam(project)).toEqual([]);
  });

  it("Form 1 — shorthand counts expand to named instances", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 2\n  quality: 1\n");

    expect(await resolveTeam(project)).toEqual([
      { persona: "principal", instance_index: 1, name: "principal-1", model: null },
      { persona: "principal", instance_index: 2, name: "principal-2", model: null },
      { persona: "quality", instance_index: 1, name: "quality-1", model: null },
    ]);
  });

  it("Form 2 — object with a shared model applies it to every instance", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(
      project,
      "default_team:\n  quality: { count: 2, model: claude-haiku-4-5-20251001 }\n",
    );

    const team = await resolveTeam(project);
    expect(team).toHaveLength(2);
    expect(team.every((i) => i.model === "claude-haiku-4-5-20251001")).toBe(true);
  });

  it("Form 3 — list of per-instance configs keeps per-instance models and names", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(
      project,
      [
        "default_team:",
        "  principal:",
        "    - { model: claude-opus-4-7 }",
        "    - { model: claude-sonnet-4-6, name: principal-balanced }",
        "",
      ].join("\n"),
    );

    expect(await resolveTeam(project)).toEqual([
      { persona: "principal", instance_index: 1, name: "principal-1", model: "claude-opus-4-7" },
      { persona: "principal", instance_index: 2, name: "principal-balanced", model: "claude-sonnet-4-6" },
    ]);
  });

  it("expands user-defined model aliases", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(
      project,
      [
        "models:",
        "  aliases:",
        "    workhorse: claude-sonnet-4-6",
        "default_team:",
        "  principal: { count: 2, model: workhorse }",
        "",
      ].join("\n"),
    );

    const team = await resolveTeam(project);
    expect(team.every((i) => i.model === "claude-sonnet-4-6")).toBe(true);
  });

  it("applies the workspace models.default when an entry sets no model", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(
      project,
      "models:\n  default: claude-opus-4-7\ndefault_team:\n  principal: 2\n",
    );

    const team = await resolveTeam(project);
    expect(team.every((i) => i.model === "claude-opus-4-7")).toBe(true);
  });

  it("ignores commented-out entries (the `# security: 1` convention)", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(
      project,
      "default_team:\n  principal: 2\n  # security: 1\n  quality: 1\n",
    );

    const team = await resolveTeam(project);
    expect(personaCount(team, "security")).toBe(0);
    expect(team.map((i) => i.persona)).toEqual(["principal", "principal", "quality"]);
  });

  it("rejects mixing forms within a single persona key", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(
      project,
      "default_team:\n  principal: { count: 2, instances: [{ model: x }] }\n",
    );

    const result = await spawnCli(["team", "resolve", "--json"], { cwd: project.dir });
    expect(result.exitCode).not.toBe(0);
  });
});

// ── 2. CUSTOM team: `--team` REPLACES default_team wholesale ──

describe("ocr team resolve --team — custom team (replaces default_team)", () => {
  it("a wholly custom roster, including personas absent from default_team", async () => {
    // The archstack-ai shape: default is principal:2/quality:2, the override
    // drops quality, trims principal, and adds an out-of-config custom roster.
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

    const team = await resolveTeam(project, [
      "--team",
      "principal:1,architect:1,infrastructure:1",
    ]);

    expect(team.map((i) => i.name)).toEqual([
      "principal-1",
      "architect-1",
      "infrastructure-1",
    ]);
    // default_team's quality is gone (replaced), and the workspace default
    // model still flows through the override instances.
    expect(personaCount(team, "quality")).toBe(0);
    expect(team.every((i) => i.model === "claude-opus-4-7")).toBe(true);
  });

  it("a SUBSET of the default roster ('default minus' a persona)", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(
      project,
      "default_team:\n  principal: 2\n  quality: 2\n  security: 1\n",
    );

    // Omit security to drop it for this run.
    const team = await resolveTeam(project, ["--team", "principal:2,quality:2"]);
    expect(personaCount(team, "principal")).toBe(2);
    expect(personaCount(team, "quality")).toBe(2);
    expect(personaCount(team, "security")).toBe(0);
  });

  it("a SUPERSET of the default roster ('default plus' a persona)", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 2\n  quality: 2\n");

    const team = await resolveTeam(project, [
      "--team",
      "principal:2,quality:2,security:1",
    ]);
    expect(personaCount(team, "security")).toBe(1);
    expect(team).toHaveLength(5);
  });

  it("multi-instance counts produce correctly indexed names", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    const team = await resolveTeam(project, ["--team", "principal:2,security:1"]);
    expect(team).toEqual([
      { persona: "principal", instance_index: 1, name: "principal-1", model: null },
      { persona: "principal", instance_index: 2, name: "principal-2", model: null },
      { persona: "security", instance_index: 1, name: "security-1", model: null },
    ]);
  });

  it("rejects a malformed spec with exit 1 and a precise error, emitting no JSON", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    // Missing the required :count — the strict schema rejects, never coerces.
    const result = await spawnCli(
      ["team", "resolve", "--team", "principal", "--json"],
      { cwd: project.dir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/:count is required/);
    expect(result.stdout.trim()).toBe("");
  });

  it("rejects an absurd count at the ceiling instead of OOM-ing (DoS guard)", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    // Without the ceiling this drives an unbounded allocation loop and crashes
    // the process; the strict schema must reject it with a clean exit 1.
    const result = await spawnCli(
      ["team", "resolve", "--team", "principal:99999999999", "--json"],
      { cwd: project.dir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/<= \d+/);
    expect(result.stdout.trim()).toBe("");
  });
});

// ── 3. SESSION override: `--session-override` MERGES onto the base ──

describe("ocr team resolve --session-override — merge onto base (dashboard path)", () => {
  it("adds a new persona on top of default_team (a literal 'plus')", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 2\n");

    const override = JSON.stringify([
      { persona: "security", instance_index: 1, name: "security-1", model: null },
    ]);
    const team = await resolveTeam(project, ["--session-override", override]);

    expect(personaCount(team, "principal")).toBe(2); // untouched
    expect(personaCount(team, "security")).toBe(1); // added
  });

  it("grows a persona's instance count", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    const override = JSON.stringify([
      { persona: "principal", instance_index: 1, name: "principal-1", model: null },
      { persona: "principal", instance_index: 2, name: "principal-2", model: null },
    ]);
    expect(personaCount(await resolveTeam(project, ["--session-override", override]), "principal")).toBe(2);
  });

  it("shrinks a persona's instance count (a literal 'minus')", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 2\n  quality: 1\n");

    const override = JSON.stringify([
      { persona: "principal", instance_index: 1, name: "principal-1", model: null },
    ]);
    const team = await resolveTeam(project, ["--session-override", override]);
    expect(personaCount(team, "principal")).toBe(1); // 2 -> 1
    expect(personaCount(team, "quality")).toBe(1); // untouched
  });

  it("swaps one persona's model and leaves siblings untouched", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n  quality: 1\n");

    const override = JSON.stringify([
      { persona: "principal", instance_index: 1, name: "principal-1", model: "claude-opus-4-7" },
    ]);
    const team = await resolveTeam(project, ["--session-override", override]);

    expect(team.find((i) => i.persona === "principal")?.model).toBe("claude-opus-4-7");
    expect(team.find((i) => i.persona === "quality")?.model).toBeNull();
  });

  it("reads the override from stdin via --session-override-stdin", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    const override = JSON.stringify([
      { persona: "security", instance_index: 1, name: "security-1", model: null },
    ]);
    const team = await resolveTeam(project, ["--session-override-stdin"], {
      stdin: override,
    });
    expect(personaCount(team, "security")).toBe(1);
  });

  it("rejects override JSON that is not an array with exit 1", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    const result = await spawnCli(
      ["team", "resolve", "--json", "--session-override", "not-json"],
      { cwd: project.dir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/could not be parsed as JSON/);
  });

  it("gates a vendor-unsafe model in the override with exit 1", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    const override = JSON.stringify([
      { persona: "security", instance_index: 1, name: "security-1", model: "sonnet|whoami" },
    ]);
    const result = await spawnCli(
      ["team", "resolve", "--json", "--session-override", override],
      { cwd: project.dir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/override security#1/);
  });
});

// ── 4. COMPOSED: `--team` base + `--session-override` merge ──

describe("ocr team resolve — composed --team base + --session-override merge", () => {
  it("merges the override on top of the --team roster, not default_team", async () => {
    const project = tracked(createInitializedProject());
    // default_team is intentionally different from the --team base to prove the
    // override merges onto --team, not the disk config.
    writeConfigYaml(project, "default_team:\n  data: 3\n");

    const override = JSON.stringify([
      { persona: "quality", instance_index: 1, name: "quality-1", model: "claude-opus-4-7" },
    ]);
    const team = await resolveTeam(project, [
      "--team",
      "principal:2,quality:1",
      "--session-override",
      override,
    ]);

    expect(personaCount(team, "data")).toBe(0); // default_team ignored
    expect(personaCount(team, "principal")).toBe(2); // from --team, untouched
    expect(team.find((i) => i.persona === "quality")?.model).toBe("claude-opus-4-7"); // overridden
  });
});

// ── 5. Human-readable output (no --json) ──

describe("ocr team resolve — human-readable output (no --json)", () => {
  it("prints a table of resolved instances", async () => {
    const project = tracked(createInitializedProject());
    writeConfigYaml(project, "default_team:\n  principal: 1\n");

    const result = await spawnCli(["team", "resolve"], { cwd: project.dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Resolved team composition");
    expect(result.stdout).toContain("principal-1");
    expect(result.stdout).toContain("(default)"); // no model set
  });

  it("prints the empty-team message when nothing resolves", async () => {
    const project = tracked(createInitializedProject());

    const result = await spawnCli(["team", "resolve"], { cwd: project.dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/No team composition resolved/);
  });
});

// ── `ocr team set --stdin` — persists default_team (the dashboard write path) ──

describe("ocr team set --stdin", () => {
  it("round-trips: set then resolve produces the same team", async () => {
    const project = tracked(createInitializedProject());
    const desired: ResolvedInstance[] = [
      { persona: "principal", instance_index: 1, name: "principal-1", model: "claude-opus-4-7" },
      { persona: "principal", instance_index: 2, name: "principal-balanced", model: "claude-sonnet-4-6" },
    ];

    const set = await spawnCli(["team", "set", "--stdin"], {
      cwd: project.dir,
      stdin: JSON.stringify(desired),
    });
    expect(set.exitCode).toBe(0);

    expect(await resolveTeam(project)).toEqual(desired);
  });

  it("regenerates reviewers-meta.json so is_default reflects the new team", async () => {
    const project = tracked(createInitializedProject());

    // Seed a reviewer library so `generateReviewersMeta` has something to
    // produce. Two personas — only one will end up in the team.
    const reviewersDir = resolve(project.dir, ".ocr/skills/references/reviewers");
    mkdirSync(reviewersDir, { recursive: true });
    writeFileSync(
      resolve(reviewersDir, "principal.md"),
      "# Principal Engineer Reviewer\n\nYou are a principal.\n",
    );
    writeFileSync(
      resolve(reviewersDir, "quality.md"),
      "# Quality Engineer Reviewer\n\nYou are a quality engineer.\n",
    );

    // Pre-write a stale meta file so we can detect that the regeneration
    // overwrote it. Mark both personas as default.
    const metaPath = resolve(project.dir, ".ocr/reviewers-meta.json");
    writeFileSync(
      metaPath,
      JSON.stringify(
        {
          schema_version: 1,
          generated_at: "2000-01-01T00:00:00.000Z",
          reviewers: [
            { id: "principal", name: "Principal", tier: "holistic", icon: "crown", description: "", focus_areas: [], is_default: true, is_builtin: true },
            { id: "quality", name: "Quality", tier: "specialist", icon: "sparkles", description: "", focus_areas: [], is_default: true, is_builtin: true },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    // Set a team that excludes `quality`. After regen, quality should be is_default=false.
    const team: ResolvedInstance[] = [
      { persona: "principal", instance_index: 1, name: "principal-1", model: null },
      { persona: "principal", instance_index: 2, name: "principal-2", model: "claude-opus-4-7" },
    ];
    const set = await spawnCli(["team", "set", "--stdin"], {
      cwd: project.dir,
      stdin: JSON.stringify(team),
    });
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("refreshed reviewers-meta.json");

    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
      generated_at: string;
      reviewers: Array<{ id: string; is_default: boolean }>;
    };
    expect(meta.generated_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(meta.reviewers.find((r) => r.id === "principal")?.is_default).toBe(true);
    expect(meta.reviewers.find((r) => r.id === "quality")?.is_default).toBe(false);
  });

  it("preserves comments and unrelated keys in config.yaml", async () => {
    const project = tracked(createInitializedProject());
    const configPath = resolve(project.dir, ".ocr/config.yaml");

    // Hand-authored config with three things we expect to survive a save:
    //   1. A top-of-file comment block (REVIEW RULES section)
    //   2. An unrelated top-level key (`runtime`)
    //   3. Inline comments on team entries that aren't being changed
    writeFileSync(
      configPath,
      [
        "# REVIEW RULES",
        "# Per-severity rules for reviewers. Only add what's truly cross-cutting.",
        "",
        "# REVIEWER TEAM",
        "",
        "default_team:",
        "  principal: 2  # Holistic architecture review",
        "  quality: 2    # Code quality and maintainability",
        "",
        "runtime:",
        "  agent_heartbeat_seconds: 90",
        "",
      ].join("\n"),
      "utf-8",
    );

    // Bump principal from 2 → 3, leave quality alone.
    const team: ResolvedInstance[] = [
      { persona: "principal", instance_index: 1, name: "principal-1", model: null },
      { persona: "principal", instance_index: 2, name: "principal-2", model: null },
      { persona: "principal", instance_index: 3, name: "principal-3", model: null },
      { persona: "quality", instance_index: 1, name: "quality-1", model: null },
      { persona: "quality", instance_index: 2, name: "quality-2", model: null },
    ];
    const set = await spawnCli(["team", "set", "--stdin"], {
      cwd: project.dir,
      stdin: JSON.stringify(team),
    });
    expect(set.exitCode).toBe(0);

    const after = readFileSync(configPath, "utf-8");

    // Top-of-file dividers and the unrelated `runtime` key all survive.
    expect(after).toContain("# REVIEW RULES");
    expect(after).toContain("# Per-severity rules for reviewers");
    expect(after).toContain("# REVIEWER TEAM");
    expect(after).toContain("agent_heartbeat_seconds: 90");

    // Unchanged quality entry keeps its inline comment.
    expect(after).toContain("# Code quality and maintainability");

    // Principal's value updated to 3 but its inline comment is also kept,
    // because we mutated the Scalar's value rather than replacing the pair.
    expect(after).toMatch(/principal:\s*3\s+#\s*Holistic architecture review/);
  });
});
