/**
 * Black-box synthesis fixture (amortized arrange) — Khorikov-classical.
 *
 * This is a **Persistent Fixture** (Meszaros, *xUnit Test Patterns*) realized
 * via on-disk snapshot/restore: a costly arrangement is built ONCE, snapshotted,
 * and reset between tests. Candidate for graduation to
 * `packages/shared/persistence/test-support` if a second e2e suite adopts the
 * pattern (see CLAUDE.md, "graduation by cause, not by count").
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
 * Why snapshotting the DB as plain files is safe: `cpSync({ recursive: true })`
 * copies `ocr.db` together with its `-wal`/`-shm` sidecars as a CONSISTENT SET
 * after every writer subprocess has exited, and the next reader replays the WAL
 * transparently on open. (It is NOT safe because the WAL is folded on exit — the
 * `state` commands the fixture drives never invoke `closeAllDatabases()`, the
 * only path that runs `PRAGMA wal_checkpoint(TRUNCATE)`; that is `ocr dashboard`
 * only. So un-checkpointed pages typically still live in `-wal` at exit.) The
 * consistency guarantee is the copy-them-together-after-quiesce, not a folded
 * WAL — which is exactly why `restore()` and the snapshot copy the WHOLE `data`
 * dir, never just `ocr.db`.
 */

import { cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnCli } from "./spawn-cli.js";
import { createInitializedProject, type TempProject } from "./temp-project.js";

/**
 * The review phase graph, walked in order to reach `synthesis`.
 *
 * NOTE: kept in lockstep with the `change-context → synthesis` spine of
 * `REVIEW_PHASE_GRAPH` / `REVIEW_PHASE_NUMBERS` in
 * `packages/shared/persistence/src/state/phase-graph.ts` — the production source
 * of truth for which phases `state advance` accepts. Black-box duplication on
 * purpose (this suite imports no internal modules); the build's "doubles as an
 * integration canary" guarantee below only holds while these stay in sync.
 */
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
   * Reset `.ocr/data` and `.ocr/sessions/{sessionId}` to the post-synthesis
   * snapshot, in place. Only those two subtrees are restored — anything a test
   * writes elsewhere in `project.dir` (e.g. payload JSON next to `.ocr/`)
   * persists across tests. Use a fixed filename per write so re-runs overwrite
   * cleanly. Call in `beforeEach` so every test starts from an identical, clean
   * synthesis state regardless of what the previous test mutated under `.ocr/`.
   */
  restore: () => void;
}

/**
 * Build one review session to `synthesis` via the real CLI, then snapshot it.
 * Returns the project, the session id, and an in-place `restore()`.
 *
 * `branch` is required so the helper carries no consumer-specific identity.
 *
 * Throws if any arrange spawn fails — surfacing a real `begin`/`advance`
 * regression loudly (this build doubles as the integration check for the
 * arrange chain, so no separate full-chain canary test is needed).
 */
export async function buildSynthesisFixture(
  sessionId: string,
  branch: string,
): Promise<SynthesisFixture> {
  const project = createInitializedProject();

  // Run a CLI subcommand and throw with the exit code + output on failure. The
  // exit code is the diagnostic that matters (e.g. "exit 7" = SCHEMA_INVALID),
  // and `--json` mode prints to stdout, so stderr can be empty on a logic fail.
  const runOrThrow = async (label: string, argv: string[]): Promise<void> => {
    const r = await spawnCli(argv, { cwd: project.dir });
    if (r.exitCode !== 0) {
      throw new Error(
        `synthesis fixture: ${label} failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`,
      );
    }
  };

  await runOrThrow("state begin", [
    "state",
    "begin",
    "--session-id",
    sessionId,
    "--branch",
    branch,
    "--workflow-type",
    "review",
    "--json",
  ]);

  for (const phase of REVIEW_PHASES) {
    await runOrThrow(`state advance --phase ${phase}`, [
      "state",
      "advance",
      "--session-id",
      sessionId,
      "--phase",
      phase,
    ]);
  }

  // Snapshot the quiesced .ocr/ (see file header on consistency semantics).
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
