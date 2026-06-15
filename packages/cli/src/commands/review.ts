/**
 * OCR Review Command
 *
 * `--resume <workflow-id>` is the OPTIONAL convenience path that backs the
 * dashboard's "Continue here" affordance and the "Pick up in terminal" handoff.
 * The BASELINE forward-resume path needs no flag at all: a human re-invokes the
 * review skill, whose Phase 0 reads `ocr state status --json` and continues from
 * `current_phase`. This command adds the same forward-only guarantees the
 * watchdog uses:
 *
 *  - It classifies the workflow via `stateStatus` (with the forward-resume
 *    config) and only resumes a stranded mid-pipeline run, continuing FORWARD
 *    from `current_phase` (never regressing).
 *  - It acquires the single-writer resume lease (so two owners can't both drive
 *    the same round) and is bounded by `runtime.forward_resume_max_attempts`;
 *    on exhaustion it performs the non-success close and refuses.
 *  - When a vendor resume adapter + captured `vendor_session_id` exist it
 *    dispatches the vendor's native resume (preserving conversational
 *    continuity); otherwise it hands off to the baseline skill re-invocation
 *    (forward progress without an adapter — work is preserved, not lost).
 */

import { Command } from "commander";
import chalk from "chalk";
import { spawnBinary } from "@open-code-review/platform";
import { join } from "node:path";
import { requireOcrSetup } from "../lib/guards.js";
import {
  ensureDatabase,
  getLatestAgentSessionWithVendorId,
  getSession,
} from "@open-code-review/persistence";
import {
  stateStatus,
  tryAcquireForwardResumeLease,
  closeForwardResumeExhausted,
} from "@open-code-review/persistence/state";
import {
  VENDOR_BINARIES,
  buildResumeArgs,
} from "@open-code-review/persistence/vendor-resume";
import {
  getForwardResumeMaxAttempts,
  getForwardResumeLeaseMs,
  getAgentHeartbeatSeconds,
} from "@open-code-review/config/runtime-config";

function fail(message: string): never {
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
}

/** The fixed CONTROL prompt — control, never context. Identical across hosts. */
const CONTROL_PROMPT =
  "Resume this OCR review: run `ocr state status --json` and act on `next_action`, " +
  "continuing forward from `current_phase` without redoing completed phases.";

export const reviewCommand = new Command("review")
  .description("Run or resume an OCR review")
  .option("--resume <workflow-id>", "Resume a prior review by its workflow session id")
  .action(async (options: { resume?: string }) => {
    if (!options.resume) {
      console.error(
        chalk.yellow(
          "Running a fresh review from the CLI is not yet supported — start one from your AI CLI's `/ocr-review` slash command or from the dashboard.",
        ),
      );
      console.error(
        chalk.dim("Use `ocr review --resume <workflow-id>` to resume a prior review."),
      );
      process.exit(1);
    }

    const targetDir = process.cwd();
    requireOcrSetup(targetDir);
    const ocrDir = join(targetDir, ".ocr");
    const db = await ensureDatabase(ocrDir);

    const workflowId = options.resume;
    const session = getSession(db, workflowId);
    if (!session) {
      fail(`Workflow session not found: ${workflowId}`);
    }

    const maxAttempts = getForwardResumeMaxAttempts(ocrDir);
    const leaseMs = getForwardResumeLeaseMs(ocrDir);
    const heartbeatMs = getAgentHeartbeatSeconds(ocrDir) * 1000;

    const status = await stateStatus(ocrDir, workflowId, {
      maxAttempts,
      heartbeatMs,
    });

    // Classify before doing anything irreversible.
    switch (status.next_action_kind) {
      case "none":
        console.error(chalk.green(`Workflow ${workflowId} is already complete — nothing to resume.`));
        process.exit(0);
        break;
      case "finish":
        console.error(
          chalk.yellow(`Workflow ${workflowId}'s round is complete but the session is still open.`),
        );
        console.error(chalk.dim("Run `ocr state finish` to close it."));
        process.exit(0);
        break;
      case "abort_or_fresh": {
        // Cap exhausted: drive the non-success terminal close, then refuse.
        closeForwardResumeExhausted(db, workflowId, maxAttempts);
        fail(
          `Forward-resume attempts exhausted for workflow ${workflowId} (cap ${maxAttempts}). ` +
            `Closed non-success (artifacts preserved). Start a fresh review, or run ` +
            `\`ocr state finish --abort\` if it was already closed.`,
        );
        break;
      }
      case "advance":
      case "complete_round":
      case "wait":
        // A live owning turn is still progressing (not stranded).
        console.error(
          chalk.yellow(
            `Workflow ${workflowId} appears to still be running (phase "${status.current_phase}"). ` +
              `Nothing to resume yet.`,
          ),
        );
        process.exit(0);
        break;
      case "reopen":
        console.error(
          chalk.yellow(`Workflow ${workflowId} was closed without a completed round.`),
        );
        console.error(chalk.dim("Re-invoke the review skill to finalize it."));
        process.exit(0);
        break;
      // "forward_resume" falls through to the resume logic below.
    }

    // Stranded mid-pipeline and forward-resumable. Acquire the single-writer
    // lease before driving a continuation.
    const lease = tryAcquireForwardResumeLease(db, workflowId, session.current_round, {
      leaseMs,
      maxAttempts,
    });
    if (!lease.acquired) {
      if (lease.reason === "cap_exhausted") {
        closeForwardResumeExhausted(db, workflowId, lease.attemptsUsed);
        fail(
          `Forward-resume attempts exhausted for workflow ${workflowId} (cap ${maxAttempts}). ` +
            `Closed non-success (artifacts preserved). Start a fresh review.`,
        );
      }
      fail(
        `A forward-resume is already in progress for workflow ${workflowId} ` +
          `(lease held). Wait for it to finish or retry after the lease expires.`,
      );
    }

    console.error(
      chalk.dim(
        `Forward-resuming workflow ${session.id} on branch ${session.branch} ` +
          `from phase "${status.current_phase}" (${status.forward_resume_attempts_remaining ?? "?"} attempt(s) left).`,
      ),
    );

    const latest = getLatestAgentSessionWithVendorId(db, workflowId);
    const binary = latest?.vendor
      ? VENDOR_BINARIES[latest.vendor as keyof typeof VENDOR_BINARIES]
      : undefined;

    if (!latest || !latest.vendor_session_id || !binary) {
      // No resume adapter / no captured vendor id → baseline handoff. We cannot
      // re-attach a specific vendor conversation, but forward progress is still
      // possible by re-invoking the review skill (continuity lost, work kept).
      console.error(
        chalk.yellow(
          `No resumable vendor session is captured for workflow ${workflowId}.`,
        ),
      );
      console.error(
        chalk.dim(
          `Continue it by re-invoking the review skill (\`/ocr-review\`) in your AI CLI — ` +
            `its Phase 0 reads \`ocr state status --json\` and continues forward from ` +
            `"${status.current_phase}". (${CONTROL_PROMPT})`,
        ),
      );
      // Not an error: this is the honest baseline path, and the lease is held so
      // a concurrent auto-resume won't double-drive.
      process.exit(0);
    }

    let args: string[];
    try {
      args = buildResumeArgs(latest.vendor, latest.vendor_session_id);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }

    console.error(chalk.dim(`Resuming via ${binary} (continue forward from "${status.current_phase}")…`));

    // Hand control to the vendor CLI with stdio inherited. The resumed
    // conversation already carries the OCR workflow context; on re-entry the
    // skill's Phase 0 re-reads state and drives forward. spawnBinary (not raw
    // spawn) handles the Windows .cmd shim case.
    const child = spawnBinary(binary, args, {
      stdio: "inherit",
      cwd: targetDir,
    });
    child.on("error", (err) => {
      fail(`Failed to spawn ${binary}: ${err.message}`);
    });
    child.on("close", (code) => {
      process.exit(code ?? 0);
    });
  });
