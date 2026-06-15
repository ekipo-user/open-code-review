/**
 * Command outcome derivation — pure function, single source of truth.
 *
 * Bridges process exit code semantics with workflow *completeness* (not just
 * the mutable status flag) so the dashboard distinguishes a genuinely finished
 * workflow from one that exited 0 while incomplete — including the
 * "completed too soon" case where the workflow is closed but its current
 * round/run never produced a terminal artifact.
 *
 * Reads the `session_completeness` view (migration v12), so the dashboard and
 * the agent `status` command derive completion from the same event-sourced
 * fact and can never disagree.
 *
 * Used both at finish time (command-runner emits outcome on the socket event)
 * and at read time (commands history route). Under node:sqlite + WAL the
 * read is live, so no merge/sync is needed before deriving.
 */

// Canonical process-sentinel codes — single source of truth in the CLI's
// exit-codes module, re-exported from the db barrel (the path the dashboard
// already loads, so no extra build entry / dist file is needed).
import {
  type Database,
  CANCELLED_EXIT_CODE as CANCEL_EXIT_CODE,
  CASCADE_CLOSE_EXIT_CODE,
  WATCHDOG_DEADLINE_EXIT_CODE,
} from '@open-code-review/persistence'
import type { CommandOutcome } from '../../shared/types.js'

/**
 * The `completeness_state` of the linked workflow, or `null` when the command
 * is not linked to a workflow (utility commands like sync-reviewers, doctor).
 */
export type WorkflowCompleteness =
  | 'complete'
  | 'closed_without_artifact'
  | 'in_flight'
  | 'open_no_artifact'
  | null

/**
 * Pure derivation from (exit_code, linked workflow completeness).
 * Returns `null` when the command has not finished.
 *
 *  - cancelled : user cancel (-2) or cascade-close by parent (-4)
 *  - failed    : any other non-zero exit
 *  - exit 0:
 *      - no linked workflow → success (utility command)
 *      - workflow complete  → success
 *      - otherwise          → incomplete (closed-without-artifact / still open)
 */
export function deriveCommandOutcome(
  exitCode: number | null,
  completeness: WorkflowCompleteness,
): CommandOutcome | null {
  if (exitCode === null) return null
  if (exitCode === CANCEL_EXIT_CODE || exitCode === CASCADE_CLOSE_EXIT_CODE) {
    return 'cancelled'
  }
  // Watchdog hard-deadline reap (-5) is explicitly recognized as a failure
  // rather than falling through the generic `!== 0` branch unseen — so triage
  // (and a future dedicated "timed out" badge; the discriminated
  // TerminationReason is tracked as the follow-up half of round-1 SF9) can tell
  // a deadline timeout apart from an arbitrary crash via the recorded code.
  if (exitCode === WATCHDOG_DEADLINE_EXIT_CODE) return 'failed'
  if (exitCode !== 0) return 'failed'
  // Exit 0 — cross-check the linked workflow's completeness.
  if (completeness === null || completeness === 'complete') return 'success'
  return 'incomplete'
}

/**
 * Orthogonal discriminator for the two cancel sentinels that both bucket
 * into `outcome: 'cancelled'`. Surfaced as a typed `cancellation_reason`
 * field so the client never needs to reach past `outcome` and match a
 * magic exit-code number to tell a user cancel from a cascade close.
 *
 *  - 'user'    : exit -2 (CANCEL_EXIT_CODE) — operator cancelled the command
 *  - 'cascade' : exit -4 (CASCADE_CLOSE_EXIT_CODE) — child stopped because
 *                its parent workflow closed
 *  - null      : any other exit code (incl. 0, failures, not-yet-finished)
 */
export function deriveCancellationReason(
  exitCode: number | null,
): 'user' | 'cascade' | null {
  if (exitCode === CANCEL_EXIT_CODE) return 'user'
  if (exitCode === CASCADE_CLOSE_EXIT_CODE) return 'cascade'
  return null
}

/**
 * Look up the linked workflow's completeness for a command_executions row.
 * Returns `null` when the row has no `workflow_id` or no workflow matches.
 *
 * Single SQL round-trip — used by both finishExecution (live read for the
 * `command:finished` socket event) and the history route.
 */
export function getWorkflowCompletenessForExecution(
  db: Database,
  executionId: number,
): WorkflowCompleteness {
  const result = db.exec(
    `SELECT sc.completeness_state
       FROM command_executions ce
       LEFT JOIN session_completeness sc ON sc.session_id = ce.workflow_id
      WHERE ce.id = ?`,
    [executionId],
  )
  const row = result[0]?.values[0]
  if (!row) return null
  const state = row[0] as string | null
  if (
    state === 'complete' ||
    state === 'closed_without_artifact' ||
    state === 'in_flight' ||
    state === 'open_no_artifact'
  ) {
    return state
  }
  return null
}
