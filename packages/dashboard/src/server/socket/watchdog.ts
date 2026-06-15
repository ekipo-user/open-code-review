/**
 * Per-execution supervisor watchdog: timing constants, the pure tick decision,
 * and the liveness-heartbeat writer.
 *
 * Extracted from command-runner.ts (round-1 S28; heartbeat ownership is
 * round-1 S19). The watchdog finalizes a wedged review whose work is done but
 * whose `close` is withheld (the leaked-grandchild-holds-the-pipe failure), and
 * bounds the "hung with no result" case. The imperative `setInterval` wiring
 * stays in the orchestrator (it needs the run's `emitStreamEvent` closure); this
 * module owns the reusable, independently-testable pieces:
 *   - the timing constants,
 *   - `decideWatchdogTick` (pure — every finalize/beat/wait rule lives here),
 *   - `makeHeartbeatBumper` (the throttled `last_heartbeat_at` writer, S19).
 */

import type { Database } from '@open-code-review/persistence'
import { WATCHDOG_DEADLINE_EXIT_CODE } from '@open-code-review/persistence'
import type { ProcessEntry } from './process-registry.js'

// The `result`-grace path fires ~30s after the agent's work completes —
// Claude-only, since OpenCode emits no terminal `result` sentinel (see
// opencode-adapter); for OpenCode the file-stdio'd `close` is primary and the
// hard deadline is the cap.
export const WATCHDOG_TICK_MS = 10_000
export const POST_RESULT_GRACE_MS = 30_000
// The hard-deadline cap is NOT a constant here — it is read per-spawn from
// runtime-config (`getWorkflowHardDeadlineMs`, default 60 min) so a large
// reviewer fleet on cold caches can raise it without a code change (round-1 S26).
/** Heartbeat write throttle so streaming output doesn't hammer the WAL. */
export const HEARTBEAT_THROTTLE_MS = 5_000
// WATCHDOG_DEADLINE_EXIT_CODE (-5) lives in the CLI's exit-codes module and is
// imported above — one definition shared by the producer (here) and the
// dashboard's outcome derivation (round-1 SF9).

// ── Watchdog tick decision (pure) ──

export type WatchdogTickInput = {
  /** Positive evidence OUR child exited, read off the ChildProcess handle
   *  (`exitCode`/`signalCode`). Strictly stronger than a PID liveness probe,
   *  which can detect death but not recycling. */
  exited: boolean
  /** Epoch ms the terminal `result` event was seen, if any. */
  resultSeenAt: number | undefined
  /** Whether that `result` reported an error (selects the finalize code). */
  resultIsError: boolean | undefined
  /** Epoch ms the execution started. */
  startedAtMs: number
  nowMs: number
  postResultGraceMs: number
  hardDeadlineMs: number
}

export type WatchdogTickDecision =
  | { action: 'wait' }
  | { action: 'beat' }
  | {
      action: 'finalize'
      /** Reap the tree only for a live child — reaping a dead child's PID
       *  risks killing an unrelated recycled-PID process, and its escaped
       *  descendants have reparented to PID 1 (unreachable) anyway. */
      reap: boolean
      exitCode: number
      reason: 'result-grace' | 'hard-deadline'
    }

/**
 * One watchdog tick, as a pure decision (round-2 SF1). The round-1 S14 guard
 * (`if (!isProcessAlive(pid)) return`) gated the ENTIRE tick — including both
 * finalize branches — so in pipe-fallback mode the original incident topology
 * (child exited, grandchild holds the inherited pipe, `close` withheld) fell
 * to the lossy 5-minute liveness sweep instead of the designed ~30s finalize.
 * The guard now gates the SIGNAL (reaping), never the finalize:
 *
 *   - result-grace / hard-deadline FINALIZE regardless of child liveness;
 *   - reaping happens only when the child is provably still ours (`!exited`);
 *   - an exited child outside both deadlines gets `wait`, NOT `beat` — bumping
 *     a dead child's heartbeat would disarm the liveness sweep's orphan-stamp
 *     backstop for the no-result case.
 */
export function decideWatchdogTick(i: WatchdogTickInput): WatchdogTickDecision {
  // Work provably done but `close` withheld past the grace: finalize with the
  // TRUE verdict from the result event. Checked before the hard deadline so a
  // run that is both past-grace and past-deadline records its real outcome.
  if (i.resultSeenAt !== undefined && i.nowMs - i.resultSeenAt > i.postResultGraceMs) {
    return {
      action: 'finalize',
      reap: !i.exited,
      exitCode: i.resultIsError ? 1 : 0,
      reason: 'result-grace',
    }
  }
  // Absolute cap regardless of state.
  if (i.nowMs - i.startedAtMs > i.hardDeadlineMs) {
    return {
      action: 'finalize',
      reap: !i.exited,
      exitCode: WATCHDOG_DEADLINE_EXIT_CODE,
      reason: 'hard-deadline',
    }
  }
  return i.exited ? { action: 'wait' } : { action: 'beat' }
}

// ── Liveness heartbeat (S19) ──

/**
 * Build the throttled heartbeat writer for one execution.
 *
 * The parent execution row's heartbeat was previously seeded once at spawn and
 * never bumped, so every long review drifted to "stalled". The returned bumper
 * is called on output activity AND on the watchdog's `beat` ticks; it writes
 * `last_heartbeat_at` at most once per `HEARTBEAT_THROTTLE_MS` (so streaming
 * output doesn't hammer the WAL) and never after the entry is finalized. The
 * `finished_at IS NULL` guard makes a late bump a no-op once the row is closed.
 */
export function makeHeartbeatBumper(
  db: Database,
  executionId: number,
  entry: ProcessEntry,
): () => void {
  return () => {
    if (entry.finalized) return
    const now = Date.now()
    if (now - (entry.lastBeatWrite ?? 0) < HEARTBEAT_THROTTLE_MS) return
    entry.lastBeatWrite = now
    try {
      db.run(
        `UPDATE command_executions SET last_heartbeat_at = datetime('now') WHERE id = ? AND finished_at IS NULL`,
        [executionId],
      )
    } catch (err) {
      console.error('[command-runner] heartbeat bump failed:', err)
    }
  }
}
