/**
 * Event-fold / completeness helpers.
 *
 * The `sessions` projection is a derivable fold over a session's
 * `orchestration_events` (the system of record). This module owns that fold
 * ({@link rebuildSessionProjection}), the terminal/reason event vocabularies
 * it keys off, and the small completeness queries the porcelain mutators use.
 *
 * Depends on the db query layer (`getEventsForSession`) and the engine type —
 * never on the state barrel. The {@link STATE_EXIT}/{@link StateError}
 * taxonomy lives in `exit-codes.ts`, NOT here.
 */

import type { Database } from "../db/engine.js";
import { getEventsForSession } from "../db/index.js";
import { isForwardResumeLease } from "./forward-resume.js";

/**
 * The terminal "reason" event types — non-artifact terminals that explain a
 * session close (abort, stale auto-close, filesystem sync, legacy import).
 * Each one independently satisfies the close-guard trigger.
 *
 * Single source of truth shared by {@link TERMINAL_EVENT_TYPES} (the fold)
 * and conceptually by:
 *   - the close-guard trigger SQL (migrations.ts `trg_sessions_close_guard`)
 *   - the known-event-type guard (migrations.ts `trg_events_known_type`)
 *   - reconcile.ts `hasReasonEvent`
 * If this list changes, those SQL definitions MUST be updated in lockstep.
 */
export const REASON_EVENT_TYPES = [
  "session_aborted",
  "session_auto_closed_stale",
  "session_synced",
  "session_legacy_import",
] as const;

// `session_closed` (the artifact-backed success terminal) plus every
// non-artifact reason terminal. `session_synced` was previously missing,
// causing rebuildSessionProjection to leave a sync-closed session 'active'
// (Blocker 2). Derived from REASON_EVENT_TYPES so the fold can never drift
// from the close-guard's reason vocabulary.
export const TERMINAL_EVENT_TYPES = new Set<string>([
  "session_closed",
  ...REASON_EVENT_TYPES,
]);

/**
 * The lifecycle facts the `sessions` projection holds, recomputed purely
 * from a session's `orchestration_events`. Proves the projection is a
 * derivable fold over the event log (the system of record), not an
 * independent source that can drift.
 */
export type DerivedLifecycle = {
  status: "active" | "closed";
  current_phase: string;
  phase_number: number;
  current_round: number;
  current_map_run: number;
};

/**
 * Fold a session's event log into its lifecycle projection, applying the
 * same rules the state mutators use. Returns `null` if the session has no
 * events.
 */
export function rebuildSessionProjection(
  db: Database,
  sessionId: string,
): DerivedLifecycle | null {
  const events = getEventsForSession(db, sessionId);
  if (events.length === 0) return null;

  const acc: DerivedLifecycle = {
    status: "active",
    current_phase: "context",
    phase_number: 1,
    current_round: 1,
    current_map_run: 1,
  };

  for (const e of events) {
    // A forward-resume lease is a `session_resumed` event tagged
    // `{kind: "forward_resume"}`. It is a concurrency annotation, NOT a
    // lifecycle transition — folding it (like a new-round re-open) would set
    // status/active and, if it carried a phase, regress `current_phase`. Skip
    // it entirely so the lease can never move the projection.
    if (isForwardResumeLease(e)) continue;
    switch (e.event_type) {
      case "session_created":
      case "session_resumed":
      case "round_started":
        acc.status = "active";
        if (e.phase) acc.current_phase = e.phase;
        if (e.phase_number != null) acc.phase_number = e.phase_number;
        if (e.round != null) acc.current_round = e.round;
        break;
      case "phase_transition":
        if (e.phase) acc.current_phase = e.phase;
        if (e.phase_number != null) acc.phase_number = e.phase_number;
        if (e.round != null) acc.current_round = e.round;
        break;
      case "round_completed":
        if (e.round != null && e.round >= acc.current_round) {
          acc.current_round = e.round;
        }
        break;
      case "map_completed":
        if (e.round != null) acc.current_map_run = e.round;
        break;
      default:
        if (TERMINAL_EVENT_TYPES.has(e.event_type)) {
          acc.status = "closed";
          acc.current_phase = "complete";
          if (e.phase_number != null) acc.phase_number = e.phase_number;
        }
    }
  }

  return acc;
}

/**
 * True when the session's current round/run has its terminal artifact event.
 * This is the completion invariant `finish` enforces.
 */
export function hasCompletionInvariant(
  db: Database,
  session: {
    id: string;
    workflow_type: string;
    current_round: number;
    current_map_run: number;
  },
): boolean {
  const eventType =
    session.workflow_type === "map" ? "map_completed" : "round_completed";
  const round =
    session.workflow_type === "map"
      ? session.current_map_run
      : session.current_round;
  const r = db.exec(
    `SELECT 1 FROM orchestration_events
       WHERE session_id = ? AND event_type = ? AND round = ? LIMIT 1`,
    [session.id, eventType, round],
  );
  return (r[0]?.values.length ?? 0) > 0;
}

/** Read the session_completeness view's state for a session. */
export function getCompletenessState(
  db: Database,
  sessionId: string,
): string | null {
  const r = db.exec(
    "SELECT completeness_state FROM session_completeness WHERE session_id = ?",
    [sessionId],
  );
  return (r[0]?.values[0]?.[0] as string | undefined) ?? null;
}
