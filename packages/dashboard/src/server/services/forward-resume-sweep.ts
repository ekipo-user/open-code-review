/**
 * Auto-forward-resume sweep (dashboard-enhanced tier).
 *
 * Detects stranded mid-pipeline runs (active, no terminal artifact, owning turn
 * dead with POSITIVE death evidence) and recovers them by invoking the SAME CLI
 * primitive a terminal operator would run — `ocr review --resume <id>`. The
 * watchdog owns only *triggering* and *bounding*; it does NOT own a second
 * resume code path. The CLI command owns the lease, the cap, the adapter
 * dispatch, and the non-success close — so a run the dashboard heals
 * automatically and one a human heals headless recover identically.
 *
 * Positive death evidence (never a stale heartbeat alone): every journaled agent
 * instance for the workflow is either ended OR has a PID confirmed dead. A
 * pid-less, unfinished instance is NOT positive evidence — such a run is left
 * for the human/terminal path rather than force-resumed.
 */

import type { Database } from '@open-code-review/persistence'
import {
  getAllSessions,
  listAgentSessionsForWorkflow,
  defaultIsAlive,
  getLatestAgentSessionWithVendorId,
} from '@open-code-review/persistence'
import {
  strandedActionByCap,
  hasTerminalArtifactEvent,
  closeForwardResumeExhausted,
} from '@open-code-review/persistence/state'
import { getEventsForSession } from '@open-code-review/persistence'

export type ForwardResumePlanItem = {
  sessionId: string
  /** `resume` → spawn `ocr review --resume`; `cap_close` → drive non-success
   *  terminal; `handoff` → no resume adapter, surface "Pick up in terminal". */
  action: 'resume' | 'cap_close' | 'handoff'
}

export type SweepConfig = {
  maxAttempts: number
  heartbeatMs: number
  /** Injectable for tests. Defaults to the shared liveness probe. */
  isAlive?: (pid: number) => boolean
  /** Injectable for tests. Defaults to `Date.now()`. */
  nowMs?: number
}

/**
 * Whether the owning turn is positively dead. Requires at least one journaled
 * instance and that EVERY instance is ended or PID-confirmed-dead. A pid-less,
 * unfinished instance fails the check (stale heartbeat is never positive death).
 */
function hasPositiveDeathEvidence(
  db: Database,
  sessionId: string,
  isAlive: (pid: number) => boolean,
): boolean {
  const instances = listAgentSessionsForWorkflow(db, sessionId)
  if (instances.length === 0) return false
  return instances.every(
    (s) => s.ended_at != null || (s.pid != null && !isAlive(s.pid)),
  )
}

/**
 * Pure-ish decision: which active sessions to auto-resume, cap-close, or hand
 * off. Reads the DB but performs no mutations or spawns.
 */
export function planForwardResume(
  db: Database,
  cfg: SweepConfig,
): ForwardResumePlanItem[] {
  const isAlive = cfg.isAlive ?? defaultIsAlive
  const plan: ForwardResumePlanItem[] = []

  for (const session of getAllSessions(db)) {
    if (session.status !== 'active') continue

    // Already complete-but-open is the Auto-Finalize case, not ours.
    const events = getEventsForSession(db, session.id)
    const workflowType = session.workflow_type === 'map' ? 'map' : 'review'
    if (hasTerminalArtifactEvent(events, workflowType, session.current_round)) {
      continue
    }

    // Only act on a positively-dead owning turn (never a stale heartbeat).
    // PID-confirmed death is the sweep's liveness authority, so we use the
    // cap-only action (not the heartbeat-gated deriveStrandedStatus, which could
    // mis-read a just-stamped heartbeat on a dead-PID instance as "live").
    if (!hasPositiveDeathEvidence(db, session.id, isAlive)) continue

    const stranded = strandedActionByCap(db, session, cfg.maxAttempts)

    if (stranded.action === 'abort_or_fresh') {
      plan.push({ sessionId: session.id, action: 'cap_close' })
      continue
    }

    // forward_resume: auto-spawn only if a resume adapter binding exists;
    // otherwise surface the terminal handoff (no second resume path).
    const latest = getLatestAgentSessionWithVendorId(db, session.id)
    plan.push({
      sessionId: session.id,
      action: latest?.vendor_session_id ? 'resume' : 'handoff',
    })
  }

  return plan
}

export type SweepDeps = {
  db: Database
  config: SweepConfig
  maxAttempts: number
  /** Spawn `ocr review --resume <sessionId>` (detached). Injectable for tests. */
  spawnResume: (sessionId: string) => void
  /** Optional logger. */
  log?: (message: string) => void
}

/**
 * Execute the plan: cap-close exhausted runs (pure DB) and spawn the CLI resume
 * for resumable ones. Handoff items are logged only — the user picks them up in
 * the terminal. Returns the executed plan.
 */
export function runForwardResumeSweep(deps: SweepDeps): ForwardResumePlanItem[] {
  const plan = planForwardResume(deps.db, deps.config)
  for (const item of plan) {
    try {
      if (item.action === 'cap_close') {
        closeForwardResumeExhausted(deps.db, item.sessionId, deps.maxAttempts)
        deps.log?.(
          `[ForwardResume] ${item.sessionId}: attempts exhausted → closed non-success`,
        )
      } else if (item.action === 'resume') {
        deps.spawnResume(item.sessionId)
        deps.log?.(`[ForwardResume] ${item.sessionId}: auto-resuming (ocr review --resume)`)
      } else {
        deps.log?.(
          `[ForwardResume] ${item.sessionId}: stranded, no resume adapter — pick up in terminal`,
        )
      }
    } catch (err) {
      deps.log?.(
        `[ForwardResume] ${item.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return plan
}
