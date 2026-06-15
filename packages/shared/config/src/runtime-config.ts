/**
 * Runtime configuration helpers.
 *
 * Reads `.ocr/config.yaml` for runtime tunables that affect how the CLI and
 * dashboard reason about agent-session liveness. Phase 1 only needs the
 * `runtime.agent_heartbeat_seconds` knob; a full YAML parser will arrive
 * with the Phase 4 team-config rewrite.
 *
 * Until then we use targeted regex extraction (matching the existing
 * convention in `installer.ts`) to avoid pulling in a YAML dependency for
 * this narrow read.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_AGENT_HEARTBEAT_SECONDS = 60;
export const DEFAULT_WORKFLOW_HARD_DEADLINE_MINUTES = 60;

/**
 * Max forward-resume attempts per round before a stranded mid-pipeline run is
 * closed non-success. A small bound: two automatic recoveries, then the run is
 * driven to a recorded `forward_resume_exhausted` terminal (artifacts preserved
 * for a manual fresh start) rather than retried forever.
 */
export const DEFAULT_FORWARD_RESUME_MAX_ATTEMPTS = 2;

/**
 * Single-writer resume-lease TTL, in seconds. The lease is renewed on each
 * `phase_transition`, so this need only exceed the longest expected SINGLE
 * phase (e.g. a cold-cache `reviews` fan-out), not the whole pipeline. A
 * generous default avoids a slow-but-alive continuation losing its lease and
 * admitting a second owner.
 */
export const DEFAULT_FORWARD_RESUME_LEASE_SECONDS = 1800;

/**
 * Read a `runtime.<key>` positive-integer tunable from `.ocr/config.yaml`.
 *
 * Returns `defaultValue` when the file is absent/unreadable, the key is
 * missing, or the value is not a positive integer (the last case also emits a
 * stderr warning). Never throws — a bad config must never block a liveness
 * sweep or a workflow spawn. Matches both the block and inline YAML forms.
 */
function readRuntimePositiveInt(
  ocrDir: string,
  key: string,
  defaultValue: number,
): number {
  const configPath = join(ocrDir, "config.yaml");
  if (!existsSync(configPath)) return defaultValue;

  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    return defaultValue;
  }

  // Match either the block form:
  //   runtime:
  //     <key>: 120
  // …or the inline form:
  //   runtime: { <key>: 120 }
  const blockMatch = content.match(
    new RegExp(
      String.raw`^runtime:\s*\n(?:\s+[^\n]*\n)*?\s+${key}:\s*([^\s#\n]+)`,
      "m",
    ),
  );
  const inlineMatch = content.match(
    new RegExp(String.raw`^runtime:\s*\{[^}]*\b${key}:\s*([^\s,}]+)`, "m"),
  );
  const raw = blockMatch?.[1] ?? inlineMatch?.[1];
  if (!raw) return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    process.stderr.write(
      `[ocr] runtime.${key} is not a positive integer (got "${raw}"); falling back to ${defaultValue}.\n`,
    );
    return defaultValue;
  }

  return parsed;
}

/**
 * Returns the configured agent-session heartbeat threshold, in seconds.
 * Falls back to {@link DEFAULT_AGENT_HEARTBEAT_SECONDS}.
 */
export function getAgentHeartbeatSeconds(ocrDir: string): number {
  return readRuntimePositiveInt(
    ocrDir,
    "agent_heartbeat_seconds",
    DEFAULT_AGENT_HEARTBEAT_SECONDS,
  );
}

/**
 * Returns the workflow hard-deadline cap in MILLISECONDS — the bound past which
 * the dashboard watchdog reaps an execution that never emitted a terminal
 * `result`. Configured as `runtime.workflow_hard_deadline_minutes` (a large
 * reviewer fleet on cold caches can legitimately exceed the 60-minute default).
 */
export function getWorkflowHardDeadlineMs(ocrDir: string): number {
  return (
    readRuntimePositiveInt(
      ocrDir,
      "workflow_hard_deadline_minutes",
      DEFAULT_WORKFLOW_HARD_DEADLINE_MINUTES,
    ) *
    60 *
    1000
  );
}

/**
 * Max forward-resume attempts per round. Falls back to
 * {@link DEFAULT_FORWARD_RESUME_MAX_ATTEMPTS}; a non-integer or value < 1 is
 * rejected (warned) and the safe default is used — the cap can never be coerced
 * to an unsafe 0/negative.
 */
export function getForwardResumeMaxAttempts(ocrDir: string): number {
  return readRuntimePositiveInt(
    ocrDir,
    "forward_resume_max_attempts",
    DEFAULT_FORWARD_RESUME_MAX_ATTEMPTS,
  );
}

/**
 * Single-writer resume-lease TTL in MILLISECONDS. Configured as
 * `runtime.forward_resume_lease_seconds`; falls back to
 * {@link DEFAULT_FORWARD_RESUME_LEASE_SECONDS}.
 */
export function getForwardResumeLeaseMs(ocrDir: string): number {
  return (
    readRuntimePositiveInt(
      ocrDir,
      "forward_resume_lease_seconds",
      DEFAULT_FORWARD_RESUME_LEASE_SECONDS,
    ) * 1000
  );
}
