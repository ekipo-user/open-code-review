/**
 * OCR State Command
 *
 * Manages workflow session state exclusively through SQLite.
 *
 * Subcommands:
 *   init       — Create a new session
 *   transition — Move session to a new phase
 *   close      — Mark session as closed
 *   show       — Display current session state
 *   sync       — Rebuild session state from filesystem artifacts
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireOcrSetup } from "../lib/guards.js";
import {
  stateInit,
  stateTransition,
  stateClose,
  stateShow,
  stateSync,
  stateRoundComplete,
  stateMapComplete,
  stateBegin,
  stateAdvance,
  stateCompleteRound,
  stateCompleteMap,
  stateStatus,
  resolveActiveSession,
  StateError,
} from "../lib/state/index.js";
import type { WorkflowType, ReviewPhase, MapPhase, RoundCompleteResult, MapCompleteResult } from "../lib/state/types.js";
import { replayCommandLog } from "../lib/db/command-log.js";
import { ensureDatabase, reconcileLegacyState } from "../lib/db/index.js";
import {
  getDb,
  saveDatabase,
  linkDashboardInvocationToWorkflow,
} from "../lib/db/index.js";

// ── Helpers ──

/**
 * Spawn-marker shape — written by the dashboard's command-runner at the
 * moment it spawns an AI workflow, read here by `state init` to bind
 * `workflow_id` on the dashboard's parent `command_executions` row.
 *
 * The marker is the durable answer to a fragile-by-construction problem:
 * env vars get stripped, prompt instructions get ignored, watcher hooks
 * miss UPDATE paths. The marker is filesystem state both processes
 * deterministically share.
 */
type DashboardSpawnMarker = {
  execution_uid: string;
  pid: number;
  started_at: string;
};

function readDashboardSpawnMarker(ocrDir: string): DashboardSpawnMarker | null {
  const path = join(ocrDir, "data", "dashboard-active-spawn.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).execution_uid !== "string" ||
    typeof (parsed as Record<string, unknown>).pid !== "number"
  ) {
    return null;
  }
  const marker = parsed as DashboardSpawnMarker;
  // Liveness check: a stale marker (dashboard crashed mid-spawn) must
  // not be consumed. `process.kill(pid, 0)` throws ESRCH when the PID
  // is gone — we treat that as "no live dashboard" and ignore the
  // marker. This prevents a crashed dashboard's leftover marker from
  // mis-linking a future CLI-only `state init` invocation.
  try {
    process.kill(marker.pid, 0);
  } catch {
    return null;
  }
  return marker;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks).toString("utf-8").trim();
  if (data.length === 0) {
    throw new Error("No data received on stdin");
  }
  return data;
}

// ── init ──

const initSubcommand = new Command("init")
  .description("Initialize a new OCR session")
  .requiredOption("--session-id <id>", "Session ID")
  .requiredOption("--branch <branch>", "Branch name")
  .requiredOption(
    "--workflow-type <type>",
    "Workflow type (review or map)",
    (value: string) => {
      if (value !== "review" && value !== "map") {
        throw new Error(
          `Invalid workflow type: "${value}". Must be "review" or "map".`,
        );
      }
      return value as WorkflowType;
    },
  )
  .option("--session-dir <dir>", "Session directory path (auto-resolved if omitted)")
  .option(
    "--dashboard-uid <uid>",
    "Dashboard command_executions uid to link this workflow to. Takes precedence over the OCR_DASHBOARD_EXECUTION_UID env var so AI shells that strip env vars can still wire the linkage.",
  )
  .action(
    async (options: {
      sessionId: string;
      branch: string;
      workflowType: WorkflowType;
      sessionDir?: string;
      dashboardUid?: string;
    }) => {
      const targetDir = process.cwd();
      requireOcrSetup(targetDir);
      const ocrDir = join(targetDir, ".ocr");

      const sessionDir =
        options.sessionDir ?? join(ocrDir, "sessions", options.sessionId);

      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }

      try {
        const sessionId = await stateInit({
          sessionId: options.sessionId,
          branch: options.branch,
          workflowType: options.workflowType,
          sessionDir,
          ocrDir,
        });

        // Late-link the dashboard's parent command_execution row to this
        // newly-created session.
        //
        // When the dashboard spawns an AI workflow it puts its own
        // command_executions.uid into `OCR_DASHBOARD_EXECUTION_UID`. The
        // session row didn't exist at that point, so workflow_id was
        // unset on the parent row. Now that the AI has created it, fill
        // the linkage in. After this UPDATE, the parent row has both
        // `workflow_id` (set here) AND `vendor_session_id` (bound by
        // command-runner from Claude's stdout) — which is what the
        // handoff route's `getLatestAgentSessionWithVendorId` lookup
        // needs to surface a resume command.
        // Three-source resolution, ordered by reliability:
        //   1. `--dashboard-uid` flag — explicit, set by command-runner's
        //      prompt injection. Survives shell stripping.
        //   2. `OCR_DASHBOARD_EXECUTION_UID` env var — depends on the
        //      AI's shell preserving unfamiliar env vars; sandboxed
        //      shells can strip these.
        //   3. Filesystem spawn marker — written by the dashboard at
        //      spawn time. This is the durable, guaranteed path: it
        //      doesn't depend on env-var inheritance or prompt-following.
        //      Used as the fallback when (1) and (2) miss.
        const markerUid = readDashboardSpawnMarker(ocrDir)?.execution_uid;
        const dashboardUid =
          options.dashboardUid ??
          process.env["OCR_DASHBOARD_EXECUTION_UID"] ??
          markerUid;
        if (dashboardUid) {
          try {
            // Linkage flows through the single-owner CLI db helper
            // (`linkDashboardInvocationToWorkflow`) — same primitive the
            // dashboard's SessionCaptureService uses. No direct SQL here.
            const db = await getDb(ocrDir);
            linkDashboardInvocationToWorkflow(db, dashboardUid, sessionId);
            saveDatabase(db, join(ocrDir, "data", "ocr.db"));
            // Diagnostic log so dashboard-linkage failures are visible in
            // the events JSONL: silently succeeding looks identical to
            // silently skipping when the env var is missing — and that
            // ambiguity hid a class of bugs through several iterations.
            console.error(
              chalk.gray(
                `[state init] linked workflow_id=${sessionId} → dashboard uid=${dashboardUid}`,
              ),
            );
          } catch (linkErr) {
            // Non-fatal — the session is created either way; only resume
            // discoverability suffers without the linkage.
            console.error(
              chalk.yellow(
                `Warning: failed to link dashboard command_execution to session: ${
                  linkErr instanceof Error ? linkErr.message : String(linkErr)
                }`,
              ),
            );
          }
        } else {
          // No flag, no env var, no marker. Running outside the
          // dashboard — leave the parent execution row unlinked.
          console.error(
            chalk.gray(
              `[state init] no dashboard linkage available (flag, env var, and marker file all absent — CLI-only invocation)`,
            ),
          );
        }

        console.log(sessionId);
      } catch (error) {
        console.error(
          chalk.red(
            `Error: ${error instanceof Error ? error.message : "Failed to initialize session"}`,
          ),
        );
        process.exit(1);
      }
    },
  );

// ── transition ──

const transitionSubcommand = new Command("transition")
  .description("Transition session to a new phase")
  .option("--session-id <id>", "Session ID (auto-detects latest active if omitted)")
  .requiredOption("--phase <phase>", "Target phase name")
  .requiredOption("--phase-number <number>", "Phase number", parseInt)
  .option("--current-round <number>", "Round number", parseInt)
  .option("--current-map-run <number>", "Map run number", parseInt)
  .action(
    async (options: {
      sessionId?: string;
      phase: string;
      phaseNumber: number;
      currentRound?: number;
      currentMapRun?: number;
    }) => {
      const targetDir = process.cwd();
      requireOcrSetup(targetDir);
      const ocrDir = join(targetDir, ".ocr");

      try {
        // Phase validation now lives in stateTransition itself, where it
        // can see the session's workflow_type and check legal transitions
        // against the workflow-typed phase graph (review vs map). The
        // previous flat VALID_PHASES set let a review workflow transition
        // to map phases (e.g. "topology") without complaint.
        // Single auto-detect path (resolveActiveSession is the back-compat
        // shim over resolveSession). Threading the explicit id through
        // gives us validation of bad ids AND the stderr announcement when
        // we auto-detect.
        const { id: sessionId } = await resolveActiveSession(
          ocrDir,
          options.sessionId,
        );

        await stateTransition({
          sessionId,
          phase: options.phase as ReviewPhase | MapPhase,
          phaseNumber: options.phaseNumber,
          round: options.currentRound,
          mapRun: options.currentMapRun,
          ocrDir,
        });

        console.log(
          `${sessionId}: ${options.phase} (phase ${options.phaseNumber})`,
        );
      } catch (error) {
        console.error(
          chalk.red(
            `Error: ${error instanceof Error ? error.message : "Failed to transition"}`,
          ),
        );
        process.exit(1);
      }
    },
  );

// ── close ──

const closeSubcommand = new Command("close")
  .description("Close a session (invariant-checked; alias of `finish`)")
  .option("--session-id <id>", "Session ID (auto-detects latest active if omitted; refuses on ambiguity)")
  .option("--abort", "Abandon the session — records a distinct, non-success terminal")
  .action(async (options: { sessionId?: string; abort?: boolean }) => {
    const targetDir = process.cwd();
    requireOcrSetup(targetDir);
    const ocrDir = join(targetDir, ".ocr");

    try {
      const { id: sessionId } = await resolveActiveSession(
        ocrDir,
        options.sessionId,
      );

      await stateClose({
        sessionId,
        ocrDir,
        abort: options.abort,
      });

      console.log(`${sessionId}: ${options.abort ? "aborted" : "closed"}`);
    } catch (error) {
      // Same typed exit-code taxonomy as `finish` — a premature close
      // (no completed round/run) exits 6 (INVARIANT_UNMET), not a generic 1.
      exitFromStateError(error, "Failed to close session");
    }
  });

// ── show ──

const showSubcommand = new Command("show")
  .description("Show current session state")
  .option("--session-id <id>", "Session ID (defaults to latest active)")
  .option("--json", "Output as JSON")
  .action(async (options: { sessionId?: string; json?: boolean }) => {
    const targetDir = process.cwd();
    requireOcrSetup(targetDir);
    const ocrDir = join(targetDir, ".ocr");

    try {
      const result = await stateShow(ocrDir, options.sessionId);

      if (!result) {
        if (options.json) {
          console.log(JSON.stringify(null));
        } else {
          console.log(chalk.dim("No active session found."));
        }
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const s = result.session;
      console.log();
      console.log(
        chalk.bold(`Session: ${s.id}`) +
          chalk.dim(` (${s.status})`),
      );
      console.log(
        chalk.dim("  Branch:    ") + chalk.white(s.branch),
      );
      console.log(
        chalk.dim("  Workflow:  ") + chalk.white(s.workflow_type),
      );
      console.log(
        chalk.dim("  Phase:     ") +
          chalk.cyan(s.current_phase) +
          chalk.dim(` (${s.phase_number})`),
      );
      if (s.workflow_type === "review") {
        console.log(
          chalk.dim("  Round:     ") + chalk.white(String(s.current_round)),
        );
      }
      if (s.workflow_type === "map") {
        console.log(
          chalk.dim("  Map Run:   ") + chalk.white(String(s.current_map_run)),
        );
      }
      console.log(
        chalk.dim("  Started:   ") + chalk.white(s.started_at),
      );
      console.log(
        chalk.dim("  Updated:   ") + chalk.white(s.updated_at),
      );

      if (result.events.length > 0) {
        console.log();
        console.log(chalk.dim("  Recent events:"));
        const recentEvents = result.events.slice(-5);
        for (const event of recentEvents) {
          const phaseInfo = event.phase ? chalk.dim(` [${event.phase}]`) : "";
          console.log(
            chalk.dim("    ") +
              chalk.white(event.event_type) +
              phaseInfo +
              chalk.dim(` at ${event.created_at}`),
          );
        }
      }
      console.log();
    } catch (error) {
      console.error(
        chalk.red(
          `Error: ${error instanceof Error ? error.message : "Failed to show state"}`,
        ),
      );
      process.exit(1);
    }
  });

// ── sync ──

const syncSubcommand = new Command("sync")
  .description("Rebuild session state from filesystem artifacts")
  .action(async () => {
    const targetDir = process.cwd();
    requireOcrSetup(targetDir);
    const ocrDir = join(targetDir, ".ocr");

    try {
      const synced = await stateSync(ocrDir);
      console.log(`Synced ${synced} session${synced !== 1 ? "s" : ""} from filesystem.`);

      // Recover command history from JSONL backup if DB was recreated
      const db = await getDb(ocrDir);
      const countResult = db.exec("SELECT COUNT(*) as c FROM command_executions");
      const totalCmds = (countResult[0]?.values[0]?.[0] as number) ?? 0;
      if (totalCmds === 0) {
        const recovered = replayCommandLog(db, ocrDir);
        if (recovered > 0) {
          saveDatabase(db, join(ocrDir, "data", "ocr.db"));
          console.log(`Recovered ${recovered} command${recovered !== 1 ? "s" : ""} from backup log.`);
        }
      }
    } catch (error) {
      console.error(
        chalk.red(
          `Error: ${error instanceof Error ? error.message : "Failed to sync"}`,
        ),
      );
      process.exit(1);
    }
  });

// ── round-complete ──

const roundCompleteSubcommand = new Command("round-complete")
  .description("Import structured round data into SQLite")
  .option("--file <path>", "Path to round-meta.json")
  .option("--stdin", "Read round-meta JSON from stdin (recommended)")
  .option("--session-id <id>", "Session ID (auto-detects latest active if omitted)")
  .option("--round <number>", "Round number (auto-detects current if omitted)", parseInt)
  .action(
    async (options: {
      file?: string;
      stdin?: boolean;
      sessionId?: string;
      round?: number;
    }) => {
      const targetDir = process.cwd();
      requireOcrSetup(targetDir);
      const ocrDir = join(targetDir, ".ocr");

      if (!options.file && !options.stdin) {
        console.error(chalk.red("Error: Provide either --file <path> or --stdin"));
        process.exit(1);
      }
      if (options.file && options.stdin) {
        console.error(chalk.red("Error: --file and --stdin are mutually exclusive"));
        process.exit(1);
      }

      try {
        let result: RoundCompleteResult;

        if (options.stdin) {
          const data = await readStdin();
          result = await stateRoundComplete({
            source: "stdin",
            ocrDir,
            data,
            sessionId: options.sessionId,
            round: options.round,
          });
        } else if (options.file) {
          result = await stateRoundComplete({
            source: "file",
            ocrDir,
            filePath: options.file,
            sessionId: options.sessionId,
            round: options.round,
          });
        } else {
          // Unreachable — mutual exclusion guard above ensures one is set
          process.exit(1);
        }

        console.log(chalk.green("Round data imported successfully."));
        if (result.metaPath) {
          console.log(chalk.dim(`Wrote ${result.metaPath}`));
        }
      } catch (error) {
        console.error(
          chalk.red(
            `Error: ${error instanceof Error ? error.message : "Failed to import round data"}`,
          ),
        );
        process.exit(1);
      }
    },
  );

// ── map-complete ──

const mapCompleteSubcommand = new Command("map-complete")
  .description("Import structured map run data into SQLite")
  .option("--file <path>", "Path to map-meta.json")
  .option("--stdin", "Read map-meta JSON from stdin (recommended)")
  .option("--session-id <id>", "Session ID (auto-detects latest active if omitted)")
  .option("--map-run <number>", "Map run number (auto-detects current if omitted)", parseInt)
  .action(
    async (options: {
      file?: string;
      stdin?: boolean;
      sessionId?: string;
      mapRun?: number;
    }) => {
      const targetDir = process.cwd();
      requireOcrSetup(targetDir);
      const ocrDir = join(targetDir, ".ocr");

      if (!options.file && !options.stdin) {
        console.error(chalk.red("Error: Provide either --file <path> or --stdin"));
        process.exit(1);
      }
      if (options.file && options.stdin) {
        console.error(chalk.red("Error: --file and --stdin are mutually exclusive"));
        process.exit(1);
      }

      try {
        let result: MapCompleteResult;

        if (options.stdin) {
          const data = await readStdin();
          result = await stateMapComplete({
            source: "stdin",
            ocrDir,
            data,
            sessionId: options.sessionId,
            mapRun: options.mapRun,
          });
        } else if (options.file) {
          result = await stateMapComplete({
            source: "file",
            ocrDir,
            filePath: options.file,
            sessionId: options.sessionId,
            mapRun: options.mapRun,
          });
        } else {
          // Unreachable — mutual exclusion guard above ensures one is set
          process.exit(1);
        }

        console.log(chalk.green("Map data imported successfully."));
        if (result.metaPath) {
          console.log(chalk.dim(`Wrote ${result.metaPath}`));
        }
      } catch (error) {
        console.error(
          chalk.red(
            `Error: ${error instanceof Error ? error.message : "Failed to import map data"}`,
          ),
        );
        process.exit(1);
      }
    },
  );

// ── reconcile ──

const reconcileSubcommand = new Command("reconcile")
  .description(
    "Heal legacy/drifted session state by deriving truth from events + artifacts",
  )
  .option("--dry-run", "Print the repair plan without writing anything")
  .option("--json", "Output the result as JSON")
  .action(async (options: { dryRun?: boolean; json?: boolean }) => {
    const targetDir = process.cwd();
    requireOcrSetup(targetDir);
    const ocrDir = join(targetDir, ".ocr");

    try {
      const db = await ensureDatabase(ocrDir);
      const result = reconcileLegacyState(db, ocrDir, { dryRun: options.dryRun });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const repairs = result.actions.filter((a) => a.kind !== "ok");
      if (repairs.length === 0) {
        console.log(chalk.dim("Nothing to reconcile — all sessions consistent."));
        return;
      }
      console.log(
        result.dryRun
          ? chalk.bold(`Reconciliation plan (${repairs.length} change(s), dry run):`)
          : chalk.bold(`Reconciled ${repairs.length} session(s):`),
      );
      for (const a of repairs) {
        console.log(`  ${chalk.cyan(a.kind)}  ${a.sessionId}`);
        console.log(`    ${chalk.dim(a.detail)}`);
      }
    } catch (error) {
      console.error(
        chalk.red(
          `Error: ${error instanceof Error ? error.message : "Failed to reconcile"}`,
        ),
      );
      process.exit(1);
    }
  });

// ── Atomic porcelain (the misuse-proof agent API) ──

/** Map a thrown error to its exit code + message, then exit. */
function exitFromStateError(error: unknown, fallback: string): never {
  if (error instanceof StateError) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(error.code);
  }
  console.error(
    chalk.red(`Error: ${error instanceof Error ? error.message : fallback}`),
  );
  process.exit(1);
}

const beginSubcommand = new Command("begin")
  .description("Start or resume a workflow and report where it stands")
  .requiredOption("--session-id <id>", "Session ID")
  .requiredOption("--branch <branch>", "Branch name")
  .requiredOption("--workflow-type <type>", "Workflow type (review or map)", (v: string) => {
    if (v !== "review" && v !== "map") {
      throw new Error(`Invalid workflow type: "${v}". Must be "review" or "map".`);
    }
    return v as WorkflowType;
  })
  .option("--session-dir <dir>", "Session directory path (auto-resolved if omitted)")
  .option("--json", "Output the result as JSON")
  .action(
    async (options: {
      sessionId: string;
      branch: string;
      workflowType: WorkflowType;
      sessionDir?: string;
      json?: boolean;
    }) => {
      const targetDir = process.cwd();
      requireOcrSetup(targetDir);
      const ocrDir = join(targetDir, ".ocr");
      const sessionDir =
        options.sessionDir ?? join(ocrDir, "sessions", options.sessionId);
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
      try {
        const result = await stateBegin({
          sessionId: options.sessionId,
          branch: options.branch,
          workflowType: options.workflowType,
          sessionDir,
          ocrDir,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : `${result.session_id}: round ${result.round}, phase ${result.phase} (${result.completeness ?? "unknown"})`,
        );
      } catch (error) {
        exitFromStateError(error, "Failed to begin session");
      }
    },
  );

const advanceSubcommand = new Command("advance")
  .description("Advance the workflow to a phase (graph-validated; phase number derived)")
  .requiredOption("--phase <phase>", "Target phase name")
  .option("--session-id <id>", "Session ID (auto-detects active if omitted)")
  .option("--current-round <number>", "Round number", parseInt)
  .option("--current-map-run <number>", "Map run number", parseInt)
  .action(
    async (options: {
      phase: string;
      sessionId?: string;
      currentRound?: number;
      currentMapRun?: number;
    }) => {
      const targetDir = process.cwd();
      requireOcrSetup(targetDir);
      const ocrDir = join(targetDir, ".ocr");
      try {
        const { id: sessionId } = await resolveActiveSession(ocrDir, options.sessionId);
        await stateAdvance({
          sessionId,
          phase: options.phase,
          round: options.currentRound,
          mapRun: options.currentMapRun,
          ocrDir,
        });
        console.log(`${sessionId}: ${options.phase}`);
      } catch (error) {
        exitFromStateError(error, "Failed to advance");
      }
    },
  );

const completeRoundSubcommand = new Command("complete-round")
  .description("Atomically finalize a review round (validate + record + transition)")
  .option("--session-id <id>", "Session ID (auto-detects active if omitted)")
  .option("--round <number>", "Round number (defaults to current)", parseInt)
  .option("--stdin", "Read round metadata JSON from stdin")
  .option("--file <path>", "Read round metadata JSON from a file")
  .option("--require-final", "Require rounds/round-N/final.md to exist")
  .option("--json", "Output the result as JSON")
  .action(
    async (options: {
      sessionId?: string;
      round?: number;
      stdin?: boolean;
      file?: string;
      requireFinal?: boolean;
      json?: boolean;
    }) => {
      const targetDir = process.cwd();
      requireOcrSetup(targetDir);
      const ocrDir = join(targetDir, ".ocr");
      try {
        const base = options.stdin
          ? { source: "stdin" as const, data: readFileSync(0, "utf-8") }
          : options.file
            ? { source: "file" as const, filePath: options.file }
            : (() => {
                throw new StateError(2, "Provide --stdin or --file with round metadata");
              })();
        const result = await stateCompleteRound({
          ...base,
          ocrDir,
          sessionId: options.sessionId,
          round: options.round,
          requireFinal: options.requireFinal,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : `${result.sessionId}: round ${result.round} complete`,
        );
      } catch (error) {
        exitFromStateError(error, "Failed to complete round");
      }
    },
  );

const completeMapSubcommand = new Command("complete-map")
  .description("Atomically finalize a map run (validate + record + transition)")
  .option("--session-id <id>", "Session ID (auto-detects active if omitted)")
  .option("--map-run <number>", "Map run number (defaults to current)", parseInt)
  .option("--stdin", "Read map metadata JSON from stdin")
  .option("--file <path>", "Read map metadata JSON from a file")
  .option("--json", "Output the result as JSON")
  .action(
    async (options: {
      sessionId?: string;
      mapRun?: number;
      stdin?: boolean;
      file?: string;
      json?: boolean;
    }) => {
      const targetDir = process.cwd();
      requireOcrSetup(targetDir);
      const ocrDir = join(targetDir, ".ocr");
      try {
        const base = options.stdin
          ? { source: "stdin" as const, data: readFileSync(0, "utf-8") }
          : options.file
            ? { source: "file" as const, filePath: options.file }
            : (() => {
                throw new StateError(2, "Provide --stdin or --file with map metadata");
              })();
        const result = await stateCompleteMap({
          ...base,
          ocrDir,
          sessionId: options.sessionId,
          mapRun: options.mapRun,
        });
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : `${result.sessionId}: map run ${result.mapRun} complete`,
        );
      } catch (error) {
        exitFromStateError(error, "Failed to complete map");
      }
    },
  );

const finishSubcommand = new Command("finish")
  .description("Close a workflow (refuses unless the current round/run is complete)")
  .option("--session-id <id>", "Session ID (auto-detects active if omitted)")
  .option("--abort", "Abandon the session — records a distinct, non-success terminal")
  .action(async (options: { sessionId?: string; abort?: boolean }) => {
    const targetDir = process.cwd();
    requireOcrSetup(targetDir);
    const ocrDir = join(targetDir, ".ocr");
    try {
      const { id: sessionId } = await resolveActiveSession(ocrDir, options.sessionId);
      await stateClose({ sessionId, ocrDir, abort: options.abort });
      console.log(`${sessionId}: ${options.abort ? "aborted" : "finished"}`);
    } catch (error) {
      exitFromStateError(error, "Failed to finish");
    }
  });

const statusSubcommand = new Command("status")
  .description("Report whether a session is complete and, if not, what's missing")
  .option("--session-id <id>", "Session ID (auto-detects active if omitted)")
  .option("--json", "Output the result as JSON")
  .action(async (options: { sessionId?: string; json?: boolean }) => {
    const targetDir = process.cwd();
    requireOcrSetup(targetDir);
    const ocrDir = join(targetDir, ".ocr");
    try {
      const result = await stateStatus(ocrDir, options.sessionId);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`${result.session_id}: ${result.completeness_state}`);
        console.log(chalk.dim(`  next: ${result.next_action}`));
      }
    } catch (error) {
      exitFromStateError(error, "Failed to read status");
    }
  });

// ── Main state command ──

export const stateCommand = new Command("state")
  .description("Manage OCR session state")
  .addCommand(initSubcommand)
  .addCommand(transitionSubcommand)
  .addCommand(closeSubcommand)
  .addCommand(showSubcommand)
  .addCommand(syncSubcommand)
  .addCommand(roundCompleteSubcommand)
  .addCommand(mapCompleteSubcommand)
  .addCommand(reconcileSubcommand)
  // Atomic porcelain (preferred agent API).
  .addCommand(beginSubcommand)
  .addCommand(advanceSubcommand)
  .addCommand(completeRoundSubcommand)
  .addCommand(completeMapSubcommand)
  .addCommand(finishSubcommand)
  .addCommand(statusSubcommand);
