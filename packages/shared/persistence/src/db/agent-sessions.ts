/**
 * Agent-session journal helpers.
 *
 * Backed by the `command_executions` table — every spawned CLI subprocess
 * gets exactly one row, whether it was started by the dashboard's command
 * runner or by the AI calling `ocr session start-instance`. The "agent
 * session" concept is a logical view over `command_executions` rows whose
 * `last_heartbeat_at` is non-null (i.e., they participate in the journaled
 * lifecycle, as opposed to fire-and-forget utility commands).
 *
 * Status mapping (derived, no separate column):
 *   running    →  finished_at IS NULL AND last_heartbeat_at fresh
 *   stalled    →  finished_at IS NULL AND last_heartbeat_at stale (advisory
 *                 only — a stale heartbeat is NOT evidence of death; the
 *                 process may be alive and simply not beating)
 *   orphaned   →  finished_at IS NOT NULL AND exit_code = -3 — written only
 *                 when the supervised pid is confirmed dead (see
 *                 sweepStaleAgentSessions), never from heartbeat age alone
 *   done       →  exit_code = 0
 *   crashed    →  exit_code IS NOT NULL AND exit_code NOT IN (0, -2, -3, -4)
 *   cancelled  →  exit_code = -2 (user cancel) OR -4 (cascade-close: the
 *                 parent workflow closed)
 */

import type { Database } from "./engine.js";
import type {
  AgentSessionRow,
  AgentSessionStatus,
  InsertAgentSessionParams,
  RowKind,
  SweepResult,
  UpdateAgentSessionParams,
} from "./types.js";
import { resultToRows, resultToRow } from "./result-mapper.js";
import { commitReasonClose } from "./queries.js";
import {
  type IsAlive,
  defaultIsAlive,
  PID_REUSE_GUARD_MS,
  sqliteUtcMs,
} from "./liveness.js";
import {
  CANCELLED_EXIT_CODE,
  ORPHAN_EXIT_CODE,
  CASCADE_CLOSE_EXIT_CODE,
} from "../state/exit-codes.js";

const NOTE_ORPHAN_PREFIX = "orphaned by liveness sweep";

/**
 * The `command` value of a reviewer-instance row (bare, or `…:<persona>-<idx>`).
 * This single constant is the load-bearing discriminator for cascade safety —
 * only non-instance (supervisor) rows fire the cascade — so the writer
 * ({@link insertAgentSession}) and the reader ({@link rowKind}) MUST share it.
 */
const INSTANCE_COMMAND = "session-instance";

/**
 * Stamp every still-in-flight `command_executions` row for a workflow as
 * terminal — used when the workflow's owning process goes away so dependent
 * child rows don't linger. Two callers:
 *   - `stateClose` (`state/index.ts`) — a clean parent-workflow close.
 *   - `sweepStaleAgentSessions` (below) — when the liveness sweep confirms a
 *     workflow's supervising process dead and orphans it.
 *
 * Sets `finished_at`, the given `exitCode`, clears `pid`, and appends `note`.
 * The caller is responsible for running this inside its own transaction so
 * the cascade commits atomically with the parent's terminal write.
 */
export function cascadeTerminateExecutions(
  db: Database,
  workflowId: string,
  exitCode: number,
  note: string,
): void {
  db.run(
    `UPDATE command_executions
       SET finished_at = datetime('now'),
           exit_code   = ?,
           pid         = NULL,
           notes       = COALESCE(notes || char(10), '') || ?
     WHERE workflow_id = ?
       AND finished_at IS NULL`,
    [exitCode, note, workflowId],
  );
}

/**
 * Internal row shape from `command_executions` SELECTs, mapped to the
 * AgentSessionRow surface for backward compatibility with existing
 * consumers (dashboard server, /api/agent-sessions, terminal handoff).
 */
type CommandExecutionRow = {
  id: number;
  uid: string | null;
  command: string;
  args: string | null;
  workflow_id: string | null;
  vendor: string | null;
  vendor_session_id: string | null;
  persona: string | null;
  instance_index: number | null;
  name: string | null;
  resolved_model: string | null;
  pid: number | null;
  started_at: string;
  last_heartbeat_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  notes: string | null;
};

function rowToAgentSession(row: CommandExecutionRow): AgentSessionRow {
  return {
    // The OCR-owned id is the `uid` column. Fall back to the integer
    // primary key for legacy command_executions rows without a uid.
    id: row.uid ?? String(row.id),
    workflow_id: row.workflow_id ?? "",
    vendor: row.vendor ?? "",
    vendor_session_id: row.vendor_session_id,
    persona: row.persona,
    instance_index: row.instance_index,
    name: row.name,
    resolved_model: row.resolved_model,
    phase: null,
    status: deriveStatus(row),
    kind: rowKind(row),
    pid: row.pid,
    started_at: row.started_at,
    last_heartbeat_at: row.last_heartbeat_at ?? row.started_at,
    ended_at: row.finished_at,
    exit_code: row.exit_code,
    notes: row.notes,
  };
}

function deriveStatus(row: CommandExecutionRow): AgentSessionStatus {
  if (row.finished_at === null) {
    // Running or stalled — callers (LivenessHeader, sweeps) reclassify
    // to 'stalled' via the heartbeat threshold check downstream.
    return "running";
  }
  if (row.exit_code === ORPHAN_EXIT_CODE) return "orphaned";
  // -2 (user cancel) and -4 (cascade-close: stopped because the parent
  // workflow closed) are both non-failure cancellations, not crashes.
  if (
    row.exit_code === CANCELLED_EXIT_CODE ||
    row.exit_code === CASCADE_CLOSE_EXIT_CODE
  ) {
    return "cancelled";
  }
  if (row.exit_code === 0) return "done";
  return "crashed";
}

/**
 * Insert a new agent-session row by inserting into `command_executions`.
 *
 * The `id` returned in `params.id` is the OCR-owned UUID we expose to
 * callers; we store it in the `uid` column of `command_executions`. The
 * row's integer primary key is internal — callers that previously relied
 * on a string id continue to work via the `uid` mapping in lookups.
 */
export function insertAgentSession(
  db: Database,
  params: InsertAgentSessionParams,
): void {
  const {
    id,
    workflow_id,
    vendor,
    persona = null,
    instance_index = null,
    name = null,
    resolved_model = null,
    pid = null,
    notes = null,
  } = params;

  const command = persona && instance_index !== null
    ? `${INSTANCE_COMMAND}:${persona}-${instance_index}`
    : INSTANCE_COMMAND;

  db.run(
    `INSERT INTO command_executions
       (uid, command, args, workflow_id, vendor, persona, instance_index, name,
        resolved_model, pid, notes, last_heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      id,
      command,
      null,
      workflow_id,
      vendor,
      persona,
      instance_index,
      name,
      resolved_model,
      pid,
      notes,
    ],
  );
}

export function getAgentSession(
  db: Database,
  id: string,
): AgentSessionRow | undefined {
  const row = resultToRow<CommandExecutionRow>(
    db.exec(
      `SELECT * FROM command_executions WHERE uid = ? AND last_heartbeat_at IS NOT NULL`,
      [id],
    ),
  );
  return row ? rowToAgentSession(row) : undefined;
}

export function listAgentSessionsForWorkflow(
  db: Database,
  workflowId: string,
): AgentSessionRow[] {
  const rows = resultToRows<CommandExecutionRow>(
    db.exec(
      `SELECT * FROM command_executions
       WHERE workflow_id = ? AND last_heartbeat_at IS NOT NULL
       ORDER BY started_at ASC, id ASC`,
      [workflowId],
    ),
  );
  return rows.map(rowToAgentSession);
}

/**
 * Returns the most recent `command_executions` row for a workflow whose
 * `vendor_session_id` is set. Used by `ocr review --resume <workflow-id>`
 * and the terminal-handoff route.
 *
 * Resolution requires an explicit `workflow_id` link. The link is
 * established at write time by the CLI's `ocr state begin` reading a
 * dashboard spawn marker (`.ocr/data/dashboard-active-spawn/{uid}.json`)
 * and binding the dashboard parent execution to the freshly-created
 * workflow id. That marker is the durable handshake — if it's present
 * the link IS made, deterministically.
 *
 * No timing derivation. No heuristic fallback. If the link is missing,
 * the workflow is genuinely unresumable (dashboard wasn't running, AI
 * ran outside the dashboard, or `state begin` was never called).
 */
export function getLatestAgentSessionWithVendorId(
  db: Database,
  workflowId: string,
): AgentSessionRow | undefined {
  const row = resultToRow<CommandExecutionRow>(
    db.exec(
      `SELECT * FROM command_executions
       WHERE workflow_id = ? AND vendor_session_id IS NOT NULL
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [workflowId],
    ),
  );
  return row ? rowToAgentSession(row) : undefined;
}

export function bumpAgentSessionHeartbeat(db: Database, id: string): void {
  db.run(
    `UPDATE command_executions
       SET last_heartbeat_at = datetime('now')
       WHERE uid = ?`,
    [id],
  );
}

/**
 * Sets `vendor_session_id` once per row. Re-binding to a different value
 * is rejected — the AI is expected to call this exactly once per agent
 * session.
 */
export function setAgentSessionVendorId(
  db: Database,
  id: string,
  vendorSessionId: string,
): void {
  const existing = getAgentSession(db, id);
  if (!existing) {
    throw new Error(`Agent session not found: ${id}`);
  }
  if (
    existing.vendor_session_id &&
    existing.vendor_session_id !== vendorSessionId
  ) {
    throw new Error(
      `Agent session ${id} already bound to vendor session ${existing.vendor_session_id}; refusing to rebind to ${vendorSessionId}`,
    );
  }
  db.run(
    `UPDATE command_executions
       SET vendor_session_id = ?,
           last_heartbeat_at = datetime('now')
       WHERE uid = ?`,
    [vendorSessionId, id],
  );
}

/**
 * Opportunistically binds a vendor session id to an unbound running row,
 * called by the dashboard command-runner when it observes a `session_id`
 * event on stdout. Returns the agent-session id (uid) that was bound, or
 * `null` if no candidate exists.
 *
 * Scoped to rows in active workflows that participate in the journal
 * (`last_heartbeat_at IS NOT NULL`) and haven't terminated.
 */
export function bindVendorSessionIdOpportunistically(
  db: Database,
  vendorSessionId: string,
): string | null {
  // Already bound? Idempotent return.
  const alreadyBound = resultToRow<{ uid: string | null }>(
    db.exec(
      `SELECT c.uid FROM command_executions c
       INNER JOIN sessions s ON s.id = c.workflow_id
       WHERE c.vendor_session_id = ?
       LIMIT 1`,
      [vendorSessionId],
    ),
  );
  if (alreadyBound?.uid) return alreadyBound.uid;

  const candidate = resultToRow<{ uid: string | null; id: number }>(
    db.exec(
      `SELECT c.uid, c.id FROM command_executions c
       INNER JOIN sessions s ON s.id = c.workflow_id
       WHERE c.finished_at IS NULL
         AND c.vendor_session_id IS NULL
         AND c.last_heartbeat_at IS NOT NULL
         AND s.status = 'active'
       ORDER BY c.started_at DESC, c.id DESC
       LIMIT 1`,
    ),
  );
  if (!candidate) return null;

  // Bind by integer id since uid may be null on older command_executions rows
  db.run(
    `UPDATE command_executions
       SET vendor_session_id = ?,
           last_heartbeat_at = datetime('now')
       WHERE id = ?`,
    [vendorSessionId, candidate.id],
  );
  return candidate.uid ?? String(candidate.id);
}

/**
 * Syntax class for a plausible vendor session id — the single source of truth
 * shared by the CLI `bind-vendor-id` command (parse-boundary validation) and
 * the dashboard's capture service (stream-boundary validation). Letters/digits
 * to start, then letters, digits, and `. _ : - `, max 256 chars.
 *
 * This is defense-in-depth: a vendor session id flows into a `--resume <id>`
 * argv and a user-facing copy-paste resume command. The shell-less spawn (see
 * `@open-code-review/platform`) is the real injection boundary, but per issue
 * #43 every parse/stream boundary that ingests an untrusted vendor string
 * validates it too — and BOTH boundaries must agree, so the regex lives here,
 * not duplicated per call site. `%` is deliberately excluded (cmd.exe
 * `%VAR%`-expansion is the weakest spot of `.cmd` argument escaping).
 */
export const SAFE_VENDOR_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Whether `id` matches {@link SAFE_VENDOR_SESSION_ID}. */
export function isSafeVendorSessionId(id: string): boolean {
  return SAFE_VENDOR_SESSION_ID.test(id);
}

/**
 * Records a vendor session id on the parent `command_executions` row
 * spawned by the dashboard. Idempotent (COALESCE) — vendors emit
 * `session_id` events on every stream message, we record only the first.
 *
 * Single-owner primitive for vendor session id capture (per the
 * add-self-diagnosing-resume-handoff proposal). Direct SQL UPDATEs to
 * `vendor_session_id` outside this helper are forbidden.
 */
export function recordVendorSessionIdForExecution(
  db: Database,
  executionId: number,
  vendorSessionId: string,
): void {
  db.run(
    `UPDATE command_executions
        SET vendor_session_id = COALESCE(vendor_session_id, ?),
            last_heartbeat_at = datetime('now')
      WHERE id = ?`,
    [vendorSessionId, executionId],
  );
}

/**
 * Late-links a dashboard-spawned `command_executions` row (identified by
 * its `uid`) to a workflow created later by the AI's `ocr state begin`
 * call. Idempotent (COALESCE) — if a workflow_id is already set the
 * UPDATE is a no-op.
 *
 * Single-owner primitive for workflow linkage (per the
 * add-self-diagnosing-resume-handoff proposal). Direct SQL UPDATEs to
 * `workflow_id` outside this helper are forbidden.
 */
export function linkDashboardInvocationToWorkflow(
  db: Database,
  dashboardUid: string,
  workflowId: string,
): void {
  db.run(
    `UPDATE command_executions
        SET workflow_id = COALESCE(workflow_id, ?),
            last_heartbeat_at = COALESCE(last_heartbeat_at, datetime('now'))
      WHERE uid = ?`,
    [workflowId, dashboardUid],
  );
}

export function setAgentSessionStatus(
  db: Database,
  id: string,
  status: AgentSessionStatus,
  options: {
    exitCode?: number | null;
    note?: string;
    setEndedAt?: boolean;
  } = {},
): void {
  const { exitCode, note, setEndedAt } = options;
  const isTerminal =
    status === "done" ||
    status === "crashed" ||
    status === "cancelled" ||
    status === "orphaned";
  const stampEnded = setEndedAt ?? isTerminal;

  // Resolve exit code from status when callers don't pass one explicitly.
  // 0 (done), -2 (cancelled), -3 (orphaned), 1 (crashed default).
  let resolvedExit: number | null;
  if (exitCode !== undefined) {
    resolvedExit = exitCode;
  } else if (status === "done") {
    resolvedExit = 0;
  } else if (status === "cancelled") {
    resolvedExit = CANCELLED_EXIT_CODE;
  } else if (status === "orphaned") {
    resolvedExit = ORPHAN_EXIT_CODE;
  } else if (status === "crashed") {
    resolvedExit = 1;
  } else {
    resolvedExit = null;
  }

  const finishedClause = stampEnded ? ", finished_at = datetime('now')" : "";

  if (note !== undefined) {
    db.run(
      `UPDATE command_executions
         SET exit_code = ?,
             notes = COALESCE(notes || char(10), '') || ?
             ${finishedClause}
         WHERE uid = ?`,
      [resolvedExit, note, id],
    );
  } else {
    db.run(
      `UPDATE command_executions
         SET exit_code = ?
             ${finishedClause}
         WHERE uid = ?`,
      [resolvedExit, id],
    );
  }
}

export function updateAgentSession(
  db: Database,
  id: string,
  params: UpdateAgentSessionParams,
): void {
  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];

  if (params.vendor_session_id !== undefined) {
    setClauses.push("vendor_session_id = ?");
    values.push(params.vendor_session_id);
  }
  // `phase` is no longer persisted on the unified table — tracked via
  // the existing orchestration_events stream instead. Silently drop.
  if (params.status !== undefined) {
    // Map status updates to exit_code transitions per deriveStatus.
    setAgentSessionStatus(db, id, params.status, {
      exitCode: params.exit_code ?? undefined,
      note: params.notes ?? undefined,
    });
    return;
  }
  if (params.pid !== undefined) {
    setClauses.push("pid = ?");
    values.push(params.pid);
  }
  if (params.ended_at !== undefined) {
    setClauses.push("finished_at = ?");
    values.push(params.ended_at);
  }
  if (params.exit_code !== undefined) {
    setClauses.push("exit_code = ?");
    values.push(params.exit_code);
  }
  if (params.notes !== undefined) {
    setClauses.push("notes = ?");
    values.push(params.notes);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  db.run(
    `UPDATE command_executions SET ${setClauses.join(", ")} WHERE uid = ?`,
    values,
  );
}

/**
 * Reclaims rows whose supervised process is genuinely gone, stamping them
 * `orphaned` (exit_code = -3). The terminal verdict is grounded in actual
 * process liveness (`isAlive`), NOT heartbeat age — a stale heartbeat alone
 * is no evidence of death (the heartbeat is not refreshed during a run, so a
 * healthy long command looks "stale" within a minute). A row is orphaned only
 * when it carries a pid, that pid is within the PID-reuse safety window, and
 * the pid is confirmed dead. Rows with no pid (no liveness signal) or older
 * than the window are left for coarser reclamation, never declared dead here.
 *
 * Heartbeat age (`thresholdSeconds`) is used only to bound which rows are
 * worth probing; it never decides the verdict on its own.
 *
 * When the dead row is a workflow's supervising/top-level process (not itself
 * a reviewer instance), its in-flight dependents are cascade-terminated in the
 * same transaction with exit `-4` — the parent's confirmed death is positive
 * evidence that its in-process children are gone too, so they don't linger as
 * `stalled` (and the session-level sweep isn't wedged by them).
 *
 * `isAlive` is injected so this stays a pure, testable db function; the
 * dashboard passes the real `process.kill`-based probe.
 */
export function sweepStaleAgentSessions(
  db: Database,
  thresholdSeconds: number,
  isAlive: IsAlive = defaultIsAlive,
): SweepResult {
  // Phase 1 — candidates: unfinished, journaled, pid-bearing rows whose
  // heartbeat has lapsed. Only pid-bearing rows can ever be orphaned, because
  // a terminal verdict needs positive evidence of death and a null pid is none.
  const candidates = resultToRows<{
    uid: string | null;
    id: number;
    pid: number | null;
    started_at: string;
    workflow_id: string | null;
    command: string;
    last_heartbeat_at: string | null;
  }>(
    db.exec(
      `SELECT uid, id, pid, started_at, workflow_id, command, last_heartbeat_at
         FROM command_executions
        WHERE finished_at IS NULL
          AND pid IS NOT NULL
          AND last_heartbeat_at IS NOT NULL
          AND (julianday('now') - julianday(last_heartbeat_at)) * 86400 > ?`,
      [thresholdSeconds],
    ),
  );
  if (candidates.length === 0) {
    return { orphanedIds: [], cascadedWorkflowIds: [] };
  }

  // Phase 2 — keep only rows whose pid is recent enough to trust AND confirmed
  // dead. A live pid (the bug we are fixing) stays running.
  const reuseCutoffMs = Date.now() - PID_REUSE_GUARD_MS;
  const dead = candidates.filter((row) => {
    if (row.pid === null) return false; // already excluded by SQL; defensive
    if (sqliteUtcMs(row.started_at) < reuseCutoffMs) return false; // pid not trustworthy
    // A pid that reads alive within the window stays in-flight. If the OS
    // recycled a dead supervisor's pid onto a stranger, we cannot prove the
    // original is dead, so we lean toward NOT issuing a false terminal verdict
    // — the row is reclaimed later at the coarse session-level sweep.
    return !isAlive(row.pid);
  });
  if (dead.length === 0) {
    return { orphanedIds: [], cascadedWorkflowIds: [] };
  }

  // Phase 3 — atomically: stamp orphaned on exactly the dead rows (by id, clear
  // pid, compare-and-set on `finished_at` so a real completion between phases
  // wins), then cascade-terminate the in-flight dependents of any dead
  // workflow-owning process. Reviewer-instance rows (`session-instance:*`)
  // never trigger a cascade — only a supervising/top-level process does — so an
  // orphaned instance can't take its live siblings down.
  const note = `${NOTE_ORPHAN_PREFIX} (threshold ${thresholdSeconds}s)`;
  const placeholders = dead.map(() => "?").join(", ");
  const cascadedWorkflowIds: string[] = [];
  db.transaction(() => {
    db.run(
      `UPDATE command_executions
          SET finished_at = datetime('now'),
              exit_code = ?,
              pid = NULL,
              notes = COALESCE(notes || char(10), '') || ?
        WHERE id IN (${placeholders})
          AND finished_at IS NULL`,
      [ORPHAN_EXIT_CODE, note, ...dead.map((r) => r.id)],
    );
    for (const row of dead) {
      if (row.workflow_id && rowKind(row) === "supervisor") {
        cascadeTerminateExecutions(
          db,
          row.workflow_id,
          CASCADE_CLOSE_EXIT_CODE,
          "cascade-closed: workflow process orphaned by liveness sweep",
        );
        cascadedWorkflowIds.push(row.workflow_id);
      }
    }
  });

  return {
    orphanedIds: dead.map((r) => r.uid ?? String(r.id)),
    cascadedWorkflowIds,
  };
}

/**
 * The role a `command_executions` row plays, derived (never stored) from the
 * two columns present on every row at every insert site — including after a
 * JSONL replay, which drops `persona`/`instance_index` but keeps `command`.
 * The {@link INSTANCE_COMMAND} value is written ONLY by `insertAgentSession`
 * (either bare, or with a `:<persona>-<idx>` suffix), so it is a total,
 * unambiguous discriminator.
 *
 * NB: an instance is the bare value OR the `…:` suffixed form — matched exactly
 * so an unrelated future command merely *prefixed* `session-instance` (e.g.
 * `session-instances`) is NOT misclassified as an instance, which would let an
 * orphaned instance cascade-kill its siblings.
 */
export function rowKind(row: {
  command: string;
  last_heartbeat_at: string | null;
}): RowKind {
  if (
    row.command === INSTANCE_COMMAND ||
    row.command.startsWith(`${INSTANCE_COMMAND}:`)
  ) {
    return "instance";
  }
  // A journaled (heartbeat-bearing) non-instance row is a workflow supervisor;
  // a row that was never journaled is a fire-and-forget utility command.
  return row.last_heartbeat_at == null ? "utility" : "supervisor";
}

/**
 * Sweep stale `sessions.status = 'active'` rows.
 *
 * A row is considered stale when ALL of the following hold:
 *   - status is still 'active'
 *   - no orchestration_event has been recorded for it within
 *     `thresholdSeconds` (default 7 days at call sites)
 *   - no dependent command_executions are still in flight
 *     (every linked row has finished_at NOT NULL)
 *
 * Stale rows are flipped to 'closed' with a `session_auto_closed_stale`
 * event recording the threshold and the last-event-age. This stops them
 * from poisoning latest-active auto-detect — the exact failure mode that
 * caused the "wrong session closed" bug.
 *
 * Returns the closed session_ids.
 */
export function sweepStaleSessions(
  db: Database,
  thresholdSeconds: number,
): import("./types.js").StaleSessionSweepResult {
  // Find active sessions whose most recent event is older than the
  // threshold AND have no in-flight dependent rows.
  const sql = `
    SELECT s.id
      FROM sessions s
      LEFT JOIN (
        SELECT session_id, MAX(created_at) AS last_event_at
          FROM orchestration_events
         GROUP BY session_id
      ) e ON e.session_id = s.id
     WHERE s.status = 'active'
       AND (
         e.last_event_at IS NULL
         OR (julianday('now') - julianday(e.last_event_at)) * 86400 > ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM command_executions ce
          WHERE ce.workflow_id = s.id
            AND ce.finished_at IS NULL
       )
  `;
  const rows = resultToRows<{ id: string }>(db.exec(sql, [thresholdSeconds]));

  if (rows.length === 0) {
    return { closedSessionIds: [] };
  }

  for (const row of rows) {
    // One transaction per session (reason event FIRST, then the status flip)
    // via the shared close primitive — upholds the D1 invariant. Per-session
    // (not whole-loop) so one failing close can't roll back the others.
    commitReasonClose(
      db,
      row.id,
      {
        event_type: "session_auto_closed_stale",
        phase: "complete",
        metadata: JSON.stringify({
          reason: "no events past threshold; no in-flight dependents",
          threshold_seconds: thresholdSeconds,
        }),
      },
      { status: "closed", current_phase: "complete" },
    );
  }

  return { closedSessionIds: rows.map((r) => r.id) };
}
