/**
 * Typed query functions for sessions and orchestration events.
 */

import type { Database } from "./engine.js";
import type {
  EventRow,
  InsertEventParams,
  InsertSessionParams,
  SessionRow,
  UpdateSessionParams,
} from "./types.js";
import { resultToRows, resultToRow } from "./result-mapper.js";

// ── Sessions ──

export function insertSession(db: Database, params: InsertSessionParams): void {
  const {
    id,
    branch,
    workflow_type,
    current_phase = "context",
    phase_number = 1,
    current_round = 1,
    current_map_run = 1,
    session_dir,
  } = params;

  db.run(
    `INSERT INTO sessions (id, branch, workflow_type, current_phase, phase_number, current_round, current_map_run, session_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, branch, workflow_type, current_phase, phase_number, current_round, current_map_run, session_dir],
  );
}

export function updateSession(
  db: Database,
  id: string,
  params: UpdateSessionParams,
): void {
  const setClauses: string[] = [];
  const values: (string | number)[] = [];

  if (params.status !== undefined) {
    setClauses.push("status = ?");
    values.push(params.status);
  }
  if (params.current_phase !== undefined) {
    setClauses.push("current_phase = ?");
    values.push(params.current_phase);
  }
  if (params.phase_number !== undefined) {
    setClauses.push("phase_number = ?");
    values.push(params.phase_number);
  }
  if (params.current_round !== undefined) {
    setClauses.push("current_round = ?");
    values.push(params.current_round);
  }
  if (params.current_map_run !== undefined) {
    setClauses.push("current_map_run = ?");
    values.push(params.current_map_run);
  }

  if (setClauses.length === 0) {
    return;
  }

  // Always update updated_at when there's something to update
  setClauses.push("updated_at = datetime('now')");

  values.push(id);
  db.run(
    `UPDATE sessions SET ${setClauses.join(", ")} WHERE id = ?`,
    values,
  );
}

export function getSession(db: Database, id: string): SessionRow | undefined {
  return resultToRow<SessionRow>(
    db.exec("SELECT * FROM sessions WHERE id = ?", [id]),
  );
}

export function getLatestActiveSession(db: Database): SessionRow | undefined {
  return resultToRow<SessionRow>(
    db.exec(
      "SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1",
    ),
  );
}

export function getAllSessions(db: Database): SessionRow[] {
  return resultToRows<SessionRow>(
    db.exec("SELECT * FROM sessions ORDER BY started_at DESC"),
  );
}

// ── Events ──

export function insertEvent(db: Database, params: InsertEventParams): void {
  const {
    session_id,
    event_type,
    phase,
    phase_number,
    round,
    metadata,
  } = params;

  db.run(
    `INSERT INTO orchestration_events (session_id, event_type, phase, phase_number, round, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      session_id,
      event_type,
      phase ?? null,
      phase_number ?? null,
      round ?? null,
      metadata ?? null,
    ],
  );
}

export function getEventsForSession(
  db: Database,
  sessionId: string,
): EventRow[] {
  return resultToRows<EventRow>(
    db.exec(
      "SELECT * FROM orchestration_events WHERE session_id = ? ORDER BY id ASC",
      [sessionId],
    ),
  );
}

export function getLatestEventId(db: Database): number {
  const result = db.exec(
    "SELECT MAX(id) FROM orchestration_events",
  );
  if (result.length === 0 || result[0]?.values.length === 0) {
    return 0;
  }
  const val = result[0]?.values[0]?.[0];
  return typeof val === "number" ? val : 0;
}

// ── Atomic reason-close ──

/**
 * Atomically record a terminal "reason" event and flip the session's
 * projection, in a single transaction with the reason event inserted
 * BEFORE the status UPDATE.
 *
 * Ordering is load-bearing: the `trg_sessions_close_guard` trigger
 * (see migrations.ts) fires on the active→closed UPDATE and aborts unless
 * a completed round/run OR a reason event already exists. Writing the
 * reason event first inside the same transaction guarantees the guard is
 * satisfied at the moment of the status change.
 *
 * Lives in this leaf module (not state/index.ts) so both the state layer
 * and reconcile.ts — which would otherwise form an import cycle through the
 * db barrel — can use it. Re-exported from `state/index.ts` and the
 * `db/index.ts` barrel for external consumers (e.g. the dashboard).
 */
export function commitReasonClose(
  db: Database,
  sessionId: string,
  reasonEvent: Omit<InsertEventParams, "session_id">,
  projectionUpdates: UpdateSessionParams,
): void {
  db.transaction(() => {
    insertEvent(db, { session_id: sessionId, ...reasonEvent });
    updateSession(db, sessionId, projectionUpdates);
  });
}
