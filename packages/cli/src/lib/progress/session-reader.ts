/**
 * Session state reader — reads from SQLite exclusively.
 *
 * Used by progress strategies to get session state.
 * Requires the DB to be pre-initialized via setProgressDb().
 */

import { basename } from "node:path";
import type { Database } from "@open-code-review/persistence";
import { resultToRow } from "@open-code-review/persistence";
import type { SessionStateData } from "./types.js";

// Cached DB reference — set once during progress command startup
let cachedDb: Database | null = null;

/**
 * Sets the cached database connection for synchronous reads.
 * Call this once at progress command startup after async DB init.
 */
export function setProgressDb(db: Database | null): void {
  cachedDb = db;
}

/**
 * Returns the cached database connection.
 */
export function getProgressDb(): Database | null {
  return cachedDb;
}

/**
 * Reads session state from SQLite.
 * Fully synchronous — requires the DB to be pre-initialized via setProgressDb().
 *
 * @param sessionPath - Path to the session directory
 * @returns Session state data or null if no state is available
 */
export function readSessionState(
  sessionPath: string,
): SessionStateData | null {
  if (!cachedDb) {
    return null;
  }

  try {
    return readFromSqlite(sessionPath, cachedDb);
  } catch {
    return null;
  }
}

type SessionDbRow = {
  id: string;
  status: "active" | "closed";
  workflow_type: "review" | "map";
  current_phase: string;
  phase_number: number;
  started_at: string;
  updated_at: string;
  current_round: number;
  current_map_run: number;
};

/**
 * Reads session state from a pre-opened SQLite database (synchronous).
 */
function readFromSqlite(
  sessionPath: string,
  db: Database,
): SessionStateData | null {
  const sessionId = basename(sessionPath);

  // Try exact session ID match first
  let row = resultToRow<SessionDbRow>(
    db.exec("SELECT * FROM sessions WHERE id = ?", [sessionId]),
  );

  // If no match, try latest active session
  if (!row) {
    row = resultToRow<SessionDbRow>(
      db.exec(
        "SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1",
      ),
    );
  }

  if (!row) {
    return null;
  }

  return {
    session_id: row.id,
    status: row.status,
    workflow_type: row.workflow_type,
    current_phase: row.current_phase,
    phase_number: row.phase_number,
    started_at: row.started_at,
    updated_at: row.updated_at,
    current_round: row.current_round,
    current_map_run: row.current_map_run,
  };
}
