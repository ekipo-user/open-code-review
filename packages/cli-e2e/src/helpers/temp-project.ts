/**
 * Create temporary project directories for e2e tests.
 *
 * Many OCR commands require a git repo and/or an initialized `.ocr/`
 * directory. These helpers set up the minimal structure needed.
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

export type TempProject = {
  dir: string;
  cleanup: () => void;
};

/**
 * Create a temp directory with a git repo (required by most OCR commands).
 */
export function createTempProject(): TempProject {
  const dir = realpathSync(
    mkdtempSync(resolve(tmpdir(), "ocr-e2e-")),
  );

  // A bare repo is the whole arrangement: `requireOcrSetup` checks `.ocr/`, not
  // git, and the CLI never reads HEAD (it takes --branch/--session-id
  // explicitly — only the dashboard server resolves the branch via `rev-parse`,
  // and that path has its own harness). So no identity config and no initial
  // commit are needed; `git init` alone is enough. One spawn, not four — fewer
  // cold subprocesses per test is the point (this is per-test arrange cost).
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });

  return {
    dir,
    // Windows can report EBUSY on rmdir for a short window after a spawned
    // CLI child exits (handle release lags the process — broke a main CI run
    // after all 42 tests PASSED). `maxRetries`/`retryDelay` make rmSync retry
    // EBUSY/EPERM/ENOTEMPTY; the try/catch is the last resort — a leaked temp
    // dir on a CI runner is harmless, a failed suite over teardown is not.
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

/**
 * Create a temp project with `.ocr/` initialized (satisfies `requireOcrSetup`).
 */
export function createInitializedProject(): TempProject {
  const project = createTempProject();

  mkdirSync(resolve(project.dir, ".ocr", "skills"), { recursive: true });
  mkdirSync(resolve(project.dir, ".ocr", "sessions"), { recursive: true });

  return project;
}

/**
 * Write a `default_team` block to the project's `.ocr/config.yaml`.
 *
 * Helper for tests that need to verify the three-form schema behavior end
 * to end — they read the resolved composition back via `ocr team resolve`.
 */
export function writeConfigYaml(project: TempProject, yamlBody: string): void {
  const configPath = resolve(project.dir, ".ocr", "config.yaml");
  writeFileSync(configPath, yamlBody, "utf-8");
}
