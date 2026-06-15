/**
 * Black-box synthesis fixture (amortized arrange) — Khorikov-classical.
 *
 * WHY: e2e cases that finalize a round must first walk a review session to the
 * `synthesis` phase. Done per-test, that arrangement is ~7 cold CLI spawns
 * (`state begin` + 6× `state advance`), each booting node + the bundled CLI +
 * `node:sqlite`. On the Windows runner that's ~55s of pure setup PER test —
 * right at the old 60s ceiling, which made it flake. The arrangement is not the
 * subject of these tests; only the final command is.
 *
 * The fix builds that precondition ONCE, through the PUBLIC interface (the real
 * `ocr` binary — no internal-module imports, consistent with this suite's
 * Khorikov-classical contract), snapshots the resulting on-disk `.ocr` artifact,
 * and restores it IN PLACE before each test. The command under test still runs
 * as a real subprocess. Net: arrangement is paid once; each test pays ~1 spawn.
 *
 * Restore is in-place (same project dir) on purpose: the DB persists an absolute
 * `session_dir`, so the snapshot is only valid for the directory it was built
 * in. The helper therefore only ever writes back into `fixture.project.dir`.
 *
 * Safe to snapshot the DB as plain files: every `ocr` subprocess TRUNCATE-
 * checkpoints the WAL on close, so once the last arrange spawn has exited,
 * `.ocr/data/ocr.db` is a quiesced, complete artifact (the `-wal`/`-shm`
 * sidecars are empty/folded). We copy the whole `data` dir regardless.
 */

import { cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnCli } from "./spawn-cli.js";
import { createInitializedProject, type TempProject } from "./temp-project.js";

/** The review phase graph, walked in order to reach `synthesis`. */
const REVIEW_PHASES = [
  "change-context",
  "analysis",
  "reviews",
  "aggregation",
  "discourse",
  "synthesis",
] as const;

const SNAPSHOT_DIRNAME = ".ocr-snapshot";

export interface SynthesisFixture {
  project: TempProject;
  sessionId: string;
  /**
   * Reset the project's `.ocr` state back to the post-synthesis snapshot, in
   * place. Call in `beforeEach` so every test starts from an identical, clean
   * synthesis state regardless of what the previous test mutated.
   */
  restore: () => void;
}

/**
 * Build one review session to `synthesis` via the real CLI, then snapshot it.
 * Returns the project, the session id, and an in-place `restore()`.
 *
 * Throws if any arrange spawn fails — surfacing a real `begin`/`advance`
 * regression loudly (this build doubles as the integration check for the
 * arrange chain, so no separate full-chain canary test is needed).
 */
export async function buildSynthesisFixture(
  sessionId: string,
  branch = "feat/verdict-contract",
): Promise<SynthesisFixture> {
  const project = createInitializedProject();

  const begin = await spawnCli(
    [
      "state",
      "begin",
      "--session-id",
      sessionId,
      "--branch",
      branch,
      "--workflow-type",
      "review",
      "--json",
    ],
    { cwd: project.dir },
  );
  if (begin.exitCode !== 0) {
    throw new Error(`synthesis fixture: 'state begin' failed: ${begin.stderr}`);
  }

  for (const phase of REVIEW_PHASES) {
    const adv = await spawnCli(
      ["state", "advance", "--session-id", sessionId, "--phase", phase],
      { cwd: project.dir },
    );
    if (adv.exitCode !== 0) {
      throw new Error(
        `synthesis fixture: 'state advance --phase ${phase}' failed: ${adv.stderr}`,
      );
    }
  }

  // All arrange subprocesses have exited (WAL truncate-checkpointed on close),
  // so `.ocr` is a complete, quiesced artifact. Snapshot it.
  const ocrDir = resolve(project.dir, ".ocr");
  const snapshotDir = resolve(project.dir, SNAPSHOT_DIRNAME);
  cpSync(ocrDir, snapshotDir, { recursive: true });

  const restore = (): void => {
    // Reset the two pieces a finalize can mutate: the SQLite DB (events/phase)
    // and the session's round artifacts. Whole-dir replace avoids torn copies.
    for (const sub of ["data", join("sessions", sessionId)]) {
      const live = resolve(ocrDir, sub);
      const snap = resolve(snapshotDir, sub);
      rmSync(live, { recursive: true, force: true });
      cpSync(snap, live, { recursive: true });
    }
  };

  return { project, sessionId, restore };
}
