/**
 * Command outcome derivation — pure function, single source of truth.
 *
 * Bridges process exit code semantics with workflow lifecycle semantics
 * so the dashboard can distinguish "AI parent process exited cleanly and
 * the workflow finished" from "AI parent process exited cleanly while the
 * workflow was still mid-flight" (the macOS-sleep / network-drop case).
 *
 * Used both at finish time (command-runner emits outcome on the socket
 * event) and at read time (commands history route projects outcome onto
 * each row). Single helper means client + server can never disagree.
 */

import type { Database } from '@open-code-review/cli/db'
import type { CommandOutcome, SessionStatus } from '../../shared/types.js'

/** Cancel sentinel set by finishExecution when the user clicks Cancel. */
const CANCEL_EXIT_CODE = -2

/**
 * Pure derivation. Takes the two facts that determine outcome and
 * returns the canonical label. Returns `null` when the command has
 * not yet finished.
 *
 * `workflowStatus = null` means either:
 *  - the command is not linked to a workflow (utility commands like
 *    sync-reviewers, doctor) — those are `success` on exit 0
 *  - or the lookup failed because the workflow row was deleted —
 *    treat as `success` to avoid spurious "incomplete" labels on
 *    historical rows whose sessions were cleaned up
 */
export function deriveCommandOutcome(
  exitCode: number | null,
  workflowStatus: SessionStatus | null,
): CommandOutcome | null {
  if (exitCode === null) return null
  if (exitCode === CANCEL_EXIT_CODE) return 'cancelled'
  if (exitCode !== 0) return 'failed'
  // Exit 0 — cross-check the linked workflow.
  if (workflowStatus === null || workflowStatus === 'closed') return 'success'
  return 'incomplete'
}

/**
 * Look up the linked workflow's status for a command_executions row.
 * Returns `null` when the row has no `workflow_id` or the workflow
 * row no longer exists.
 *
 * Single SQL round-trip — used by both finishExecution (for the
 * `command:finished` socket event) and the history route (for
 * computing outcome on every row).
 */
export function getWorkflowStatusForExecution(
  db: Database,
  executionId: number,
): SessionStatus | null {
  const result = db.exec(
    `SELECT s.status
       FROM command_executions ce
       LEFT JOIN sessions s ON s.id = ce.workflow_id
      WHERE ce.id = ?`,
    [executionId],
  )
  const row = result[0]?.values[0]
  if (!row) return null
  const status = row[0] as string | null
  if (status === 'active' || status === 'closed') return status
  return null
}
