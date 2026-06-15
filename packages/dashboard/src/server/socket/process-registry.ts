/**
 * In-process registry of active dashboard-spawned commands.
 *
 * Extracted from command-runner.ts (round-1 S28) so the orchestrator
 * (command-runner), the watchdog, and the finalizer share ONE module-singleton
 * `activeCommands` Map without an import cycle. This module is a leaf: it owns
 * the `ProcessEntry` shape, the concurrency cap, the map, and the read-only
 * accessors the HTTP routes use. Nothing here imports the orchestrator, so
 * watchdog.ts / finalizer.ts can depend on it freely.
 */

import type { ChildProcess } from 'node:child_process'
import type { FileTailer } from '../services/ai-cli/file-tailer.js'

/** Maximum simultaneous dashboard-spawned commands. */
export const MAX_CONCURRENT = 3

export type ProcessEntry = {
  process: ChildProcess | null
  executionId: number
  uid: string
  argsJson: string
  outputBuffer: string
  commandStr: string
  startedAt: string
  /** Whether the process was spawned with detached: true (supports process group kill). */
  detached: boolean
  /** Set by the cancel handler. `finishExecution` applies cancel-wins
   *  centrally off this flag (round-1 SF4): whichever trigger finalizes — the
   *  close handler, the watchdog, or a result — the recorded exit code becomes
   *  CANCELLED_EXIT_CODE when this is true. */
  cancelled: boolean
  /** Workflow-id auto-link polling timer; cleared on process close. */
  linkPoll?: ReturnType<typeof setInterval>
  /**
   * First-wins finalization guard. Finalization can be triggered by the
   * vendor `result` event (work done), `proc.on('close')` (EOF), the watchdog,
   * or cancel — whichever fires first wins; the rest are no-ops. Decouples
   * finalization from stdio EOF, which a leaked grandchild can hold open.
   */
  finalized?: boolean
  /** Epoch ms when the terminal `result` event was seen (watchdog input). */
  resultSeenAt?: number
  /** Whether the terminal `result` reported an error (sets the watchdog exit code). */
  resultIsError?: boolean
  /** Per-execution supervisor/watchdog timer; cleared on finalize. */
  watchdog?: ReturnType<typeof setInterval>
  /** Last epoch ms a heartbeat was written for this row (throttle). */
  lastBeatWrite?: number
  /**
   * File tailer for file-stdio workflows — reads the per-execution log the
   * detached agent writes its stdout/stderr to (in place of an OS pipe a
   * leaked grandchild could hold open). Drained + closed on finalize.
   */
  tailer?: FileTailer
}

/** Active commands keyed by execution_id. Module-singleton — every consumer
 *  (orchestrator, watchdog, finalizer, routes) shares this one instance. */
export const activeCommands = new Map<number, ProcessEntry>()

/**
 * Returns whether any command is currently running.
 */
export function isCommandRunning(): boolean {
  return activeCommands.size > 0
}

/**
 * Returns the number of currently running commands.
 */
export function getRunningCount(): number {
  return activeCommands.size
}

export type ActiveCommandInfo = {
  execution_id: number
  command: string
  started_at: string
  output: string
}

/**
 * Returns metadata and output for all currently running commands.
 */
export function getActiveCommands(): ActiveCommandInfo[] {
  return Array.from(activeCommands.values()).map((entry) => ({
    execution_id: entry.executionId,
    command: entry.commandStr,
    started_at: entry.startedAt,
    output: entry.outputBuffer,
  }))
}
