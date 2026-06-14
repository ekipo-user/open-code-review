/**
 * OCR Session Command
 *
 * Manages the per-instance agent-session journal in SQLite. The AI workflow
 * calls these subcommands to declare lifecycle moments for the agent-CLI
 * processes it spawns on behalf of a review (one row per reviewer instance,
 * plus the Tech Lead's own row).
 *
 * Subcommands:
 *   start-instance    — Insert a new row in 'running' status; returns the new
 *                       agent-session UUID on stdout
 *   bind-vendor-id    — Bind the underlying CLI's session id to an agent
 *                       session (idempotent on the same id, rejects rebind)
 *   beat              — Bump last_heartbeat_at to "now"
 *   end-instance      — Transition to a terminal status (done/crashed/cancelled)
 *   list              — Print agent_sessions rows, optionally filtered by workflow
 */

import { Command } from "commander";
import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { requireOcrSetup } from "../lib/guards.js";
import {
  ensureDatabase,
  bumpAgentSessionHeartbeat,
  getAgentSession,
  insertAgentSession,
  listAgentSessionsForWorkflow,
  setAgentSessionStatus,
  setAgentSessionVendorId,
  sweepStaleAgentSessions,
  SAFE_VENDOR_SESSION_ID,
} from "@open-code-review/persistence";
import { getAgentHeartbeatSeconds } from "@open-code-review/config/runtime-config";
import { resolveActiveSession } from "@open-code-review/persistence/state";
import type { AgentSessionStatus, AgentVendor } from "@open-code-review/persistence";

// ── Helpers ──

const TERMINAL_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  "done",
  "crashed",
  "cancelled",
  "orphaned",
]);

function fail(message: string): never {
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
}

async function setup(): Promise<{ ocrDir: string }> {
  const targetDir = process.cwd();
  requireOcrSetup(targetDir);
  const ocrDir = join(targetDir, ".ocr");
  return { ocrDir };
}

// ── start-instance ──

const startInstanceSubcommand = new Command("start-instance")
  .description("Journal a new agent-CLI process spawned for the active review")
  .option("--workflow <id>", "Workflow session id (auto-detects active if omitted)")
  .option("--persona <name>", "Reviewer persona, e.g. 'principal'")
  .option("--instance <number>", "Instance index within (workflow, persona)", parseInt)
  .option("--name <name>", "Human-friendly name (default: '{persona}-{instance}')")
  .requiredOption("--vendor <vendor>", "Underlying CLI vendor (e.g. 'claude', 'opencode')")
  .option("--model <id>", "Resolved model id passed to the CLI's --model flag")
  .option("--phase <phase>", "Workflow phase this instance is doing")
  .option("--pid <pid>", "Process id of the spawned process", parseInt)
  .option("--note <text>", "Free-form note to attach")
  .action(
    async (options: {
      workflow?: string;
      persona?: string;
      instance?: number;
      name?: string;
      vendor: AgentVendor;
      model?: string;
      phase?: string;
      pid?: number;
      note?: string;
    }) => {
      const { ocrDir } = await setup();
      const db = await ensureDatabase(ocrDir);

      try {
        const { id: workflowId } = await resolveActiveSession(
          ocrDir,
          options.workflow,
        );

        const id = randomUUID();
        const persona = options.persona ?? null;
        const instanceIndex = options.instance ?? null;
        const derivedName =
          options.name ??
          (persona && instanceIndex !== null
            ? `${persona}-${instanceIndex}`
            : null);

        // Sweep stale rows opportunistically — the spec mandates a sweep on
        // every new agent-session creation, in addition to dashboard startup.
        const heartbeatSeconds = getAgentHeartbeatSeconds(ocrDir);
        sweepStaleAgentSessions(db, heartbeatSeconds);

        insertAgentSession(db, {
          id,
          workflow_id: workflowId,
          vendor: options.vendor,
          persona,
          instance_index: instanceIndex,
          name: derivedName,
          resolved_model: options.model ?? null,
          phase: options.phase ?? null,
          pid: options.pid ?? null,
          notes: options.note ?? null,
        });

        console.log(id);
      } catch (error) {
        fail(error instanceof Error ? error.message : "Failed to start agent session");
      }
    },
  );

// ── bind-vendor-id ──
//
// The argv-safety syntax class for vendor session ids (issue #43) is
// SAFE_VENDOR_SESSION_ID, imported from the db layer so this parse-boundary
// check and the dashboard's stream-boundary check (capture service) share one
// definition. A bound id is STICKY (rebinding is refused) and later becomes
// spawn argv (`--session <id>`), so a garbage bind both poisons resume and
// rides into a child process invocation. The class covers every real shape
// (Claude Code UUIDs, OpenCode `ses_…`) and is deliberately NOT per-vendor
// grammar — vendors drift id formats silently and the caller is an AI
// orchestrator mid-workflow where a false rejection fails the review.

const bindVendorIdSubcommand = new Command("bind-vendor-id")
  .description("Bind the underlying CLI's session id to an OCR agent session")
  .argument("<agent-session-id>", "OCR agent session id")
  .argument("<vendor-session-id>", "Underlying CLI's session id")
  .action(async (agentId: string, vendorId: string) => {
    if (!SAFE_VENDOR_SESSION_ID.test(vendorId)) {
      fail(
        `vendor-session-id ${JSON.stringify(vendorId)} is not a plausible vendor session id ` +
          "(allowed: letters and digits plus . _ : - , max 256 chars). " +
          "Nothing was bound — retry with the id the vendor CLI actually emitted.",
      );
    }
    const { ocrDir } = await setup();
    const db = await ensureDatabase(ocrDir);

    try {
      setAgentSessionVendorId(db, agentId, vendorId);
      console.log(`${agentId}: vendor_session_id=${vendorId}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : "Failed to bind vendor session id");
    }
  });

// ── beat ──

const beatSubcommand = new Command("beat")
  .description("Bump last_heartbeat_at on an agent session")
  .argument("<agent-session-id>", "OCR agent session id")
  .action(async (agentId: string) => {
    const { ocrDir } = await setup();
    const db = await ensureDatabase(ocrDir);

    try {
      const existing = getAgentSession(db, agentId);
      if (!existing) {
        fail(`Agent session not found: ${agentId}`);
      }
      bumpAgentSessionHeartbeat(db, agentId);
      console.log(`${agentId}: heartbeat`);
    } catch (error) {
      fail(error instanceof Error ? error.message : "Failed to bump heartbeat");
    }
  });

// ── end-instance ──

const endInstanceSubcommand = new Command("end-instance")
  .description("Transition an agent session to a terminal status")
  .argument("<agent-session-id>", "OCR agent session id")
  .option(
    "--status <status>",
    "Terminal status (done | crashed | cancelled). Default inferred from --exit-code (0 → done, non-zero → crashed)",
  )
  .option("--exit-code <code>", "Process exit code", parseInt)
  .option("--note <text>", "Free-form note to append")
  .action(
    async (
      agentId: string,
      options: { status?: string; exitCode?: number; note?: string },
    ) => {
      const { ocrDir } = await setup();
      const db = await ensureDatabase(ocrDir);

      try {
        const existing = getAgentSession(db, agentId);
        if (!existing) {
          fail(`Agent session not found: ${agentId}`);
        }

        let status: AgentSessionStatus;
        if (options.status) {
          if (!TERMINAL_STATUSES.has(options.status as AgentSessionStatus)) {
            fail(
              `Invalid --status: "${options.status}". Must be one of: done, crashed, cancelled.`,
            );
          }
          if (options.status === "orphaned") {
            fail(
              "--status orphaned is reserved for the liveness sweep; use 'cancelled' or 'crashed' instead.",
            );
          }
          status = options.status as AgentSessionStatus;
        } else if (options.exitCode === 0) {
          status = "done";
        } else if (typeof options.exitCode === "number") {
          status = "crashed";
        } else {
          status = "done";
        }

        setAgentSessionStatus(db, agentId, status, {
          exitCode: options.exitCode ?? null,
          note: options.note,
        });
        console.log(`${agentId}: ${status}`);
      } catch (error) {
        fail(error instanceof Error ? error.message : "Failed to end agent session");
      }
    },
  );

// ── list ──

const listSubcommand = new Command("list")
  .description("List agent sessions for a workflow (or the active workflow)")
  .option("--workflow <id>", "Workflow session id (auto-detects active if omitted)")
  .option("--json", "Emit JSON array instead of human-readable rows")
  .action(async (options: { workflow?: string; json?: boolean }) => {
    const { ocrDir } = await setup();
    const db = await ensureDatabase(ocrDir);

    try {
      const { id: workflowId } = await resolveActiveSession(
        ocrDir,
        options.workflow,
      );
      const rows = listAgentSessionsForWorkflow(db, workflowId);

      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log(chalk.dim(`No agent sessions for workflow ${workflowId}`));
        return;
      }

      console.log(chalk.bold(`Agent sessions for ${workflowId}`));
      for (const row of rows) {
        const tag = row.name ?? row.id.slice(0, 8);
        const model = row.resolved_model ?? chalk.dim("(default)");
        const status =
          row.status === "running"
            ? chalk.green(row.status)
            : row.status === "orphaned" || row.status === "crashed"
              ? chalk.red(row.status)
              : chalk.dim(row.status);
        console.log(
          `  ${tag.padEnd(20)} ${row.vendor.padEnd(10)} ${String(model).padEnd(40)} ${status}`,
        );
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Failed to list agent sessions");
    }
  });

// ── Main session command ──

export const sessionCommand = new Command("session")
  .description("Manage agent-CLI session lifecycle journal")
  .addCommand(startInstanceSubcommand)
  .addCommand(bindVendorIdSubcommand)
  .addCommand(beatSubcommand)
  .addCommand(endInstanceSubcommand)
  .addCommand(listSubcommand);
