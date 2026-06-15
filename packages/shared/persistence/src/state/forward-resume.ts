/**
 * Forward-resume of a stranded mid-pipeline run.
 *
 * A run is *stranded mid-pipeline* when it is `active`, its current round has no
 * terminal `round_completed` event, and its owning agent turn has ended. Such a
 * run is recoverable by continuing FORWARD from its event-sourced
 * `current_phase` — never by re-deriving a "validated phase" (the event log has
 * no per-phase artifact evidence) and never by regressing the phase.
 *
 * Concurrency is guarded by a single-writer **resume lease**: a `session_resumed`
 * event tagged `{kind: "forward_resume"}` in its metadata (the existing event
 * type, discriminated by metadata — no taxonomy change). The lease event carries
 * NO `phase`/`phase_number`/`round` column, so the projection fold cannot regress
 * `current_phase` through it; the round it belongs to is recorded in metadata.
 *
 * This module is server/CLI-side (it reads the DB). The pure helpers
 * ({@link remainingPhasesAfter}, {@link forwardResumeLeaseState}) take their
 * inputs explicitly so they are deterministic and unit-testable.
 */

import type { Database } from "../db/engine.js";
import type { EventRow } from "../db/types.js";
import {
  getEventsForSession,
  insertEvent,
  commitReasonClose,
  listAgentSessionsForWorkflow,
} from "../db/index.js";
import { sqliteUtcMs } from "../db/liveness.js";
import {
  REVIEW_PHASE_NUMBERS,
  MAP_PHASE_NUMBERS,
  type WorkflowKind,
} from "./phase-graph.js";

/** Metadata discriminator marking a `session_resumed` event as a resume lease
 *  (vs. `begin`'s untagged new-round re-open `session_resumed`). */
export const FORWARD_RESUME_KIND = "forward_resume";

/** The reason recorded on the non-success close when the cap is exhausted. */
export const FORWARD_RESUME_EXHAUSTED_REASON = "forward_resume_exhausted";

/** The closed stranded-run next-action vocabulary. */
export type StrandedAction = "forward_resume" | "abort_or_fresh";

type LeaseMetadata = { kind?: string; round?: number };

function parseLeaseMetadata(e: EventRow): LeaseMetadata | null {
  if (e.event_type !== "session_resumed" || !e.metadata) return null;
  try {
    return JSON.parse(e.metadata) as LeaseMetadata;
  } catch {
    return null;
  }
}

/** True when `e` is a forward-resume lease event (not a new-round re-open). */
export function isForwardResumeLease(e: EventRow): boolean {
  return parseLeaseMetadata(e)?.kind === FORWARD_RESUME_KIND;
}

/**
 * Ordered phases strictly AFTER `currentPhase`, through `complete`, for the
 * workflow type. Empty when `currentPhase` is unknown or already terminal.
 */
export function remainingPhasesAfter(
  workflowType: WorkflowKind,
  currentPhase: string,
): string[] {
  const numbers =
    workflowType === "map" ? MAP_PHASE_NUMBERS : REVIEW_PHASE_NUMBERS;
  const cur = numbers[currentPhase];
  if (cur === undefined) return [];
  return Object.entries(numbers)
    .filter(([, n]) => n > cur)
    .sort((a, b) => a[1] - b[1])
    .map(([phase]) => phase);
}

/** True when the round has its terminal `round_completed`/`map_completed`. */
export function hasTerminalArtifactEvent(
  events: EventRow[],
  workflowType: WorkflowKind,
  round: number,
): boolean {
  const terminal =
    workflowType === "map" ? "map_completed" : "round_completed";
  return events.some((e) => e.event_type === terminal && e.round === round);
}

/** Count of forward-resume leases recorded for `round`. */
export function countForwardResumeLeases(
  events: EventRow[],
  round: number,
): number {
  return events.filter((e) => parseLeaseMetadata(e)?.kind === FORWARD_RESUME_KIND
    && parseLeaseMetadata(e)?.round === round).length;
}

export type LeaseState = {
  /** Forward-resume leases recorded for the round (the cap counter). */
  leaseCount: number;
  /** Whether a lease is currently held (within TTL, renewed by later
   *  `phase_transition`s) — a second owner must NOT start while true. */
  activeLeaseHeld: boolean;
};

/**
 * Compute the lease state for a round. The latest lease is "held" until its
 * effective timestamp — the max of the lease's own time and any later
 * `phase_transition` for the round (the renewal heartbeat) — ages past
 * `leaseMs`. Pure: `nowMs` is supplied by the caller.
 */
export function forwardResumeLeaseState(
  events: EventRow[],
  round: number,
  leaseMs: number,
  nowMs: number,
): LeaseState {
  const leases = events.filter(
    (e) => parseLeaseMetadata(e)?.kind === FORWARD_RESUME_KIND
      && parseLeaseMetadata(e)?.round === round,
  );
  if (leases.length === 0) return { leaseCount: 0, activeLeaseHeld: false };

  // Events are ordered by id ASC, so the last lease is the most recent.
  const latestLease = leases[leases.length - 1]!;
  const latestLeaseMs = sqliteUtcMs(latestLease.created_at);

  // Renewal: the newest phase_transition for this round at/after the lease.
  let effectiveMs = latestLeaseMs;
  for (const e of events) {
    if (
      e.event_type === "phase_transition" &&
      (e.round == null || e.round === round)
    ) {
      const t = sqliteUtcMs(e.created_at);
      if (t >= latestLeaseMs && t > effectiveMs) effectiveMs = t;
    }
  }

  return {
    leaseCount: leases.length,
    activeLeaseHeld: nowMs - effectiveMs < leaseMs,
  };
}

export type AcquireOptions = {
  leaseMs: number;
  maxAttempts: number;
  /** Defaults to `Date.now()`; injectable for tests. */
  nowMs?: number;
};

export type AcquireResult =
  | { acquired: true; attemptsUsed: number }
  | {
      acquired: false;
      reason: "cap_exhausted" | "lease_held";
      attemptsUsed: number;
    };

/**
 * Atomically acquire a forward-resume lease for `round`. In ONE transaction:
 * read the events, reject if the cap is exhausted or a live lease is held,
 * else append the (phase/round-column-free) lease event. Because the append is
 * inside the same transaction as the predicate read on a serialized writer, two
 * concurrent owners cannot both acquire — and because the lease is appended
 * before the continuation starts, the attempt is counted even if the
 * continuation dies before doing any work.
 */
export function tryAcquireForwardResumeLease(
  db: Database,
  sessionId: string,
  round: number,
  opts: AcquireOptions,
): AcquireResult {
  const nowMs = opts.nowMs ?? Date.now();
  return db.transaction<AcquireResult>(() => {
    const events = getEventsForSession(db, sessionId);
    const { leaseCount, activeLeaseHeld } = forwardResumeLeaseState(
      events,
      round,
      opts.leaseMs,
      nowMs,
    );
    if (leaseCount >= opts.maxAttempts) {
      return { acquired: false, reason: "cap_exhausted", attemptsUsed: leaseCount };
    }
    if (activeLeaseHeld) {
      return { acquired: false, reason: "lease_held", attemptsUsed: leaseCount };
    }
    // Lease event: NO phase/phase_number/round column → projection fold ignores
    // it for lifecycle; the round lives in metadata for cap counting.
    insertEvent(db, {
      session_id: sessionId,
      event_type: "session_resumed",
      metadata: JSON.stringify({ kind: FORWARD_RESUME_KIND, round }),
    });
    return { acquired: true, attemptsUsed: leaseCount + 1 };
  });
}

/**
 * Whether the workflow's owning agent turn is still live — any agent-session
 * instance that has not ended and whose heartbeat is fresh (within
 * `heartbeatMs`). A live owning turn means the run is NOT stranded; a human or
 * the watchdog must not treat it as forward-resumable.
 */
export function hasLiveOwningTurn(
  db: Database,
  sessionId: string,
  heartbeatMs: number,
  nowMs: number,
): boolean {
  const instances = listAgentSessionsForWorkflow(db, sessionId);
  return instances.some(
    (s) =>
      s.ended_at == null &&
      nowMs - sqliteUtcMs(s.last_heartbeat_at) <= heartbeatMs,
  );
}

export type StrandedConfig = {
  maxAttempts: number;
  heartbeatMs: number;
  /** Defaults to `Date.now()`; injectable for tests. */
  nowMs?: number;
};

export type StrandedStatus = {
  action: StrandedAction;
  remainingPhases: string[];
  attemptsRemaining: number;
};

/**
 * Classify an `active`, incomplete (no terminal artifact for the current round)
 * session as forward-resumable or not. Returns `null` when the owning turn is
 * still live (run is progressing, not stranded). Otherwise returns the
 * stranded action: `forward_resume` while attempts remain, else `abort_or_fresh`.
 *
 * The caller MUST have already established that the session is `active` and its
 * current round has no terminal artifact event.
 */
export function deriveStrandedStatus(
  db: Database,
  session: {
    id: string;
    workflow_type: string;
    current_phase: string;
    current_round: number;
  },
  cfg: StrandedConfig,
): StrandedStatus | null {
  const nowMs = cfg.nowMs ?? Date.now();
  if (hasLiveOwningTurn(db, session.id, cfg.heartbeatMs, nowMs)) return null;
  return strandedActionByCap(db, session, cfg.maxAttempts);
}

/**
 * The stranded action keyed ONLY on the cap (forward_resume while attempts
 * remain, else abort_or_fresh), for a run already KNOWN to be stranded. Callers
 * with their own, stronger liveness authority (e.g. the dashboard sweep's
 * PID-confirmed death evidence) use this directly rather than re-applying the
 * heartbeat gate in {@link deriveStrandedStatus}.
 */
export function strandedActionByCap(
  db: Database,
  session: {
    workflow_type: string;
    current_phase: string;
    current_round: number;
    id: string;
  },
  maxAttempts: number,
): StrandedStatus {
  const events = getEventsForSession(db, session.id);
  const leaseCount = countForwardResumeLeases(events, session.current_round);
  const workflowType: WorkflowKind =
    session.workflow_type === "map" ? "map" : "review";
  return {
    action: leaseCount >= maxAttempts ? "abort_or_fresh" : "forward_resume",
    remainingPhases: remainingPhasesAfter(workflowType, session.current_phase),
    attemptsRemaining: Math.max(0, maxAttempts - leaseCount),
  };
}

/**
 * Drive a cap-exhausted run to its non-success terminal: a guarded close via the
 * already-permitted `session_auto_closed_stale` reason, tagged
 * `forward_resume_exhausted`. Never a success close, never `session_aborted`;
 * on-disk artifacts are preserved for a manual fresh start.
 */
export function closeForwardResumeExhausted(
  db: Database,
  sessionId: string,
  attempts: number,
): void {
  commitReasonClose(
    db,
    sessionId,
    {
      event_type: "session_auto_closed_stale",
      phase: "complete",
      metadata: JSON.stringify({
        reason: FORWARD_RESUME_EXHAUSTED_REASON,
        attempts,
      }),
    },
    { status: "closed", current_phase: "complete" },
  );
}
