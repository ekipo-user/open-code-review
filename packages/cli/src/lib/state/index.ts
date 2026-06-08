/**
 * OCR State Management Module — barrel + porcelain.
 *
 * Manages session state exclusively through SQLite (.ocr/data/ocr.db).
 *
 * This module is the canonical public surface of the state layer. The
 * cohesive concerns have been extracted into sibling modules; this file keeps
 * the porcelain mutators (the misuse-proof agent API) and re-exports the full
 * public surface as a BARREL so every existing importer keeps working
 * unchanged:
 *
 *   - exit-codes.ts  — {@link STATE_EXIT}, {@link StateError}, process sentinels
 *   - phase-graph.ts — phase numbers, transition graphs, validatePhaseTransition
 *   - round-meta.ts  — validateRoundMeta, computeRoundCounts
 *   - map-meta.ts    — validateMapMeta, computeMapCounts
 *   - projection.ts  — event-fold + completeness helpers
 *   - meta-util.ts   — shared sanitizeMetadataString
 */

import type { Database } from "../db/engine.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  ensureDatabase,
  insertSession,
  updateSession,
  getSession,
  getLatestActiveSession,
  getAllSessions,
  insertEvent,
  getEventsForSession,
  commitReasonClose,
  cascadeTerminateExecutions,
} from "../db/index.js";
import { join } from "node:path";
import type {
  InitParams,
  TransitionParams,
  CloseParams,
  ShowResult,
  RoundCompleteParams,
  RoundCompleteResult,
  RoundMeta,
  SynthesisCounts,
  MapCompleteParams,
  MapCompleteResult,
  MapMeta,
  SessionStatus,
  ReviewPhase,
  MapPhase,
} from "./types.js";

import { STATE_EXIT, StateError, CASCADE_CLOSE_EXIT_CODE } from "./exit-codes.js";
import {
  phaseNumberFor,
  validatePhaseTransition,
} from "./phase-graph.js";
import { validateRoundMeta, computeRoundCounts } from "./round-meta.js";
import { validateMapMeta, computeMapCounts } from "./map-meta.js";
import {
  hasCompletionInvariant,
  getCompletenessState,
} from "./projection.js";

// ── Public re-export barrel ──
//
// Surfaces everything the rest of the codebase imports from this module so
// existing import paths (`../state/index.js`, `../index.js` in tests) keep
// working unchanged after the module split.

export type {
  InitParams,
  TransitionParams,
  CloseParams,
  ShowResult,
  RoundCompleteParams,
  RoundCompleteResult,
  RoundMeta,
  RoundMetaFinding,
  SynthesisCounts,
  FindingCategory,
  FindingSeverity,
  WorkflowType,
  SessionStatus,
  ReviewPhase,
  MapPhase,
  MapCompleteParams,
  MapCompleteResult,
  MapMeta,
  MapMetaSection,
  MapMetaFile,
  MapMetaDependency,
} from "./types.js";

// Exit-code taxonomy, error class, and the negative process sentinels live in
// the leaf `exit-codes.ts`. Re-exported here (and from the db barrel) so both
// the state layer's consumers and the dashboard can import them canonically.
export {
  STATE_EXIT,
  StateError,
  CANCELLED_EXIT_CODE,
  ORPHAN_EXIT_CODE,
  CASCADE_CLOSE_EXIT_CODE,
} from "./exit-codes.js";

// Phase-graph state machine.
export {
  REVIEW_PHASE_NUMBERS,
  MAP_PHASE_NUMBERS,
  phaseNumberFor,
  graphFor,
  initialPhaseFor,
  validatePhaseTransition,
} from "./phase-graph.js";
export type { WorkflowKind } from "./phase-graph.js";

// Round-meta / map-meta validation + count helpers.
export { validateRoundMeta, computeRoundCounts } from "./round-meta.js";
export { validateMapMeta, computeMapCounts } from "./map-meta.js";

// Shared metadata sanitizer.
export { sanitizeMetadataString } from "./meta-util.js";

// Event-fold / completeness helpers.
export {
  REASON_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  rebuildSessionProjection,
  hasCompletionInvariant,
  getCompletenessState,
} from "./projection.js";
export type { DerivedLifecycle } from "./projection.js";

/**
 * Re-export of the atomic reason-close primitive. It physically lives in the
 * leaf `db/queries.ts` module (surfaced via the db barrel) to avoid an import
 * cycle — reconcile.ts also uses it — but is re-exported here so the state
 * layer and external consumers (the dashboard) can import it from the
 * canonical state module as well.
 */
export { commitReasonClose };

// ── Private helpers ──

/**
 * Derive the next round number from `round_completed` events.
 *
 * Events are authoritative — they record what actually happened. The
 * filesystem is observational and may drift. If the highest completed
 * round is N, the next round is N+1. If no rounds have completed yet,
 * the next round is the session's current_round (i.e. still on the
 * current round — caller is resuming, not advancing).
 */
function deriveNextRound(
  db: Database,
  sessionId: string,
  fallbackRound: number,
): number {
  const result = db.exec(
    `SELECT MAX(round) FROM orchestration_events
       WHERE session_id = ? AND event_type = 'round_completed'`,
    [sessionId],
  );
  const max = result[0]?.values[0]?.[0];
  if (typeof max === "number") return max + 1;
  return fallbackRound;
}

/** Returns true if the directory contains at least one .md or .json file (recursively). */
function hasArtifacts(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (hasArtifacts(join(dir, entry.name))) return true;
      } else if (/\.(md|json)$/.test(entry.name)) {
        return true;
      }
    }
  } catch {
    // Permission error or similar — treat as empty
  }
  return false;
}

/**
 * Read raw JSON string from either a file path or a raw data string.
 */
function readJsonFromSource(
  params: { source: "file"; filePath: string } | { source: "stdin"; data: string },
): string {
  if (params.source === "file") {
    if (!existsSync(params.filePath)) {
      throw new StateError(STATE_EXIT.NOT_FOUND, `File not found: ${params.filePath}`);
    }
    return readFileSync(params.filePath, "utf-8");
  }
  return params.data;
}

/**
 * Parse a raw JSON string, throwing a descriptive error on failure.
 */
function parseRawJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new StateError(
      STATE_EXIT.SCHEMA_INVALID,
      `Failed to parse ${label}: ${err instanceof Error ? err.message : "invalid JSON"}`,
    );
  }
}

// ── Lifecycle mutators ──

/**
 * Initialize a session in SQLite.
 *
 * If the session already exists (e.g. round-1 completed and closed),
 * re-opens it for the next round instead of failing silently on the
 * UNIQUE constraint.
 */
export async function stateInit(params: InitParams): Promise<string> {
  const { sessionId, branch, workflowType, sessionDir, ocrDir } = params;
  const db = await ensureDatabase(ocrDir);

  const existing = getSession(db, sessionId);

  if (existing) {
    // Workflow type compatibility: re-opening with a different type would
    // corrupt phase semantics (review vs map have disjoint phase graphs).
    if (existing.workflow_type !== workflowType) {
      throw new StateError(
        STATE_EXIT.USAGE,
        `Cannot re-open session ${sessionId} as workflow_type "${workflowType}": ` +
          `existing workflow_type is "${existing.workflow_type}". ` +
          `Maps and reviews have disjoint phase graphs.`,
      );
    }

    // Session exists — derive next round from DB events (authoritative)
    // rather than filesystem (observational). Previously this read
    // rounds/round-N/final.md presence on disk, which broke if the disk
    // state was missing or out-of-sync with the DB. Events are the
    // system of record; filesystem is a side-effect.
    const nextRound = deriveNextRound(db, sessionId, existing.current_round);

    // Each workflow type starts at its own initial phase. The phase
    // graph treats review and map vocabularies as disjoint — using the
    // wrong one here causes every subsequent transition to be rejected.
    const initialPhase = workflowType === "map" ? "map-context" : "context";

    // Re-open the session for the next round (projection + event atomic).
    db.transaction(() => {
      updateSession(db, sessionId, {
        status: "active",
        current_phase: initialPhase,
        phase_number: 1,
        current_round: nextRound,
      });

      insertEvent(db, {
        session_id: sessionId,
        event_type:
          nextRound > (existing.current_round ?? 1)
            ? "round_started"
            : "session_resumed",
        phase: initialPhase,
        phase_number: 1,
        round: nextRound,
      });
    });

    return sessionId;
  }

  const initialPhase = workflowType === "map" ? "map-context" : "context";

  // New session — original path (projection + event atomic).
  db.transaction(() => {
    insertSession(db, {
      id: sessionId,
      branch,
      workflow_type: workflowType,
      current_phase: initialPhase,
      phase_number: 1,
      current_round: 1,
      current_map_run: 1,
      session_dir: sessionDir,
    });

    insertEvent(db, {
      session_id: sessionId,
      event_type: "session_created",
      phase: initialPhase,
      phase_number: 1,
      round: 1,
    });
  });

  return sessionId;
}

/**
 * Transition a session to a new phase in SQLite.
 *
 * Accepts an optional already-open `db` handle so callers that have already
 * opened the database (e.g. {@link stateAdvance}) can avoid a redundant
 * second open. When omitted, the handle is opened from `ocrDir`.
 */
export async function stateTransition(
  params: TransitionParams,
  db?: Database,
): Promise<void> {
  const { sessionId, phase, phaseNumber, round, mapRun, ocrDir } = params;
  db ??= await ensureDatabase(ocrDir);

  const existing = getSession(db, sessionId);
  if (!existing) {
    throw new StateError(STATE_EXIT.NOT_FOUND, `Session not found: ${sessionId}`);
  }

  const previousRound = existing.current_round;
  const previousMapRun = existing.current_map_run;
  const isRoundBoundary =
    (round !== undefined && round !== previousRound) ||
    (mapRun !== undefined && mapRun !== previousMapRun);

  validatePhaseTransition(
    existing.workflow_type,
    existing.current_phase,
    phase,
    isRoundBoundary,
  );

  // Event + projection commit together so the sessions row can never reflect
  // a phase the event log doesn't record (and vice versa).
  db.transaction(() => {
    updateSession(db, sessionId, {
      current_phase: phase,
      phase_number: phaseNumber,
      ...(round !== undefined ? { current_round: round } : {}),
      ...(mapRun !== undefined ? { current_map_run: mapRun } : {}),
    });

    insertEvent(db, {
      session_id: sessionId,
      event_type: "phase_transition",
      phase,
      phase_number: phaseNumber,
      round: round ?? existing.current_round,
    });

    // If round changed, also insert a round_started event
    if (round !== undefined && round !== previousRound) {
      insertEvent(db, {
        session_id: sessionId,
        event_type: "round_started",
        phase,
        phase_number: phaseNumber,
        round,
      });
    }
  });
}

/**
 * Close a session in SQLite.
 *
 * Idempotent: if the session is already `closed`, returns without writing
 * a second `session_closed` event.
 *
 * Cascades to dependent `command_executions` rows: any still in flight
 * (finished_at IS NULL) for this workflow are stamped terminal with
 * exit_code = -4 and a structured note. Without this, closing a workflow
 * left stranded child rows whose only cleanup path was the heartbeat
 * liveness sweep — and that sweep depends on the dashboard running.
 */
export async function stateClose(params: CloseParams): Promise<void> {
  const { sessionId, ocrDir, abort } = params;
  const db = await ensureDatabase(ocrDir);

  const existing = getSession(db, sessionId);
  if (!existing) {
    throw new StateError(STATE_EXIT.NOT_FOUND, `Session not found: ${sessionId}`);
  }

  if (existing.status === "closed") {
    // Idempotent no-op. Caller still gets a clean exit; the stderr
    // notice tells them their action had no effect — useful when the AI
    // accidentally retries close after a successful first attempt.
    console.error(`[ocr] Session already closed: ${sessionId}`);
    return;
  }

  // Completion invariant (app-level guard; the DB close-guard trigger is the
  // backstop). A normal close requires the current round/run to be complete.
  // `--abort` records a distinct, non-success terminal instead.
  if (!abort && !hasCompletionInvariant(db, existing)) {
    const what =
      existing.workflow_type === "map"
        ? `map run ${existing.current_map_run} has no map_completed event`
        : `round ${existing.current_round} has no round_completed event`;
    throw new StateError(
      STATE_EXIT.INVARIANT_UNMET,
      `Cannot close session ${sessionId}: ${what}. ` +
        `Run 'ocr state complete-round' to finalize it, or pass --abort to record an abandoned session.`,
    );
  }

  const note = "closed by parent workflow close";
  db.transaction(() => {
    if (abort) {
      // Reason event FIRST so the close-guard trigger is satisfied at the
      // status UPDATE; abort is a recorded, non-success terminal.
      insertEvent(db, {
        session_id: sessionId,
        event_type: "session_aborted",
        phase: existing.current_phase,
        phase_number: existing.phase_number,
        round: existing.current_round,
      });
    }

    updateSession(db, sessionId, {
      status: "closed",
      current_phase: "complete",
    });

    if (!abort) {
      insertEvent(db, {
        session_id: sessionId,
        event_type: "session_closed",
        phase: "complete",
        phase_number: existing.phase_number,
        round: existing.current_round,
      });
    }

    // Cascade: terminate any dependent command_executions rows still in
    // flight. Without this, a workflow close leaves orphan rows that only
    // the heartbeat sweep can recover — and that sweep needs the dashboard
    // running. Doing it here makes close authoritative.
    cascadeTerminateExecutions(db, sessionId, CASCADE_CLOSE_EXIT_CODE, note);
  });
}

/**
 * Show session state from SQLite.
 */
export async function stateShow(
  ocrDir: string,
  sessionId?: string,
): Promise<ShowResult | null> {
  let db: Database;
  try {
    db = await ensureDatabase(ocrDir);
  } catch {
    return null;
  }

  const session = sessionId
    ? getSession(db, sessionId)
    : getLatestActiveSession(db);

  if (!session) {
    return null;
  }

  const events = getEventsForSession(db, session.id);

  return {
    session: {
      id: session.id,
      branch: session.branch,
      status: session.status,
      workflow_type: session.workflow_type,
      current_phase: session.current_phase,
      phase_number: session.phase_number,
      current_round: session.current_round,
      current_map_run: session.current_map_run,
      started_at: session.started_at,
      updated_at: session.updated_at,
    },
    events: events.map((e) => ({
      id: e.id,
      event_type: e.event_type,
      phase: e.phase,
      phase_number: e.phase_number,
      round: e.round,
      metadata: e.metadata,
      created_at: e.created_at,
    })),
  };
}

/**
 * List all sessions from SQLite.
 */
export async function stateList(
  ocrDir: string,
): Promise<ShowResult["session"][]> {
  let db: Database;
  try {
    db = await ensureDatabase(ocrDir);
  } catch {
    return [];
  }

  const sessions = getAllSessions(db);
  return sessions.map((s) => ({
    id: s.id,
    branch: s.branch,
    status: s.status,
    workflow_type: s.workflow_type,
    current_phase: s.current_phase,
    phase_number: s.phase_number,
    current_round: s.current_round,
    current_map_run: s.current_map_run,
    started_at: s.started_at,
    updated_at: s.updated_at,
  }));
}

// ── Session resolution ──

/**
 * How the resolver arrived at the chosen session. Surfaced on the
 * result so callers (and tests) can verify the decision path. Also
 * printed to stderr by {@link announceResolveDecision} so users see
 * which session a command will affect when they omit `--session-id`.
 */
export type ResolveDecision = "explicit" | "dashboard-uid" | "latest-active";

export type ResolveSessionResult = {
  id: string;
  session_dir: string;
  current_round: number;
  current_map_run: number;
  workflow_type: "review" | "map";
  // Projection fields carried through so callers that need them (completion,
  // status) don't have to re-`getSession` and dereference with a `!`.
  status: SessionStatus;
  current_phase: string;
  phase_number: number;
  branch: string;
  decision: ResolveDecision;
};

/**
 * Single source of truth for "which session does this CLI invocation
 * apply to?". Replaces the two parallel helpers that previously diverged
 * (resolveActiveSession + resolveSessionForCompletion). Used by every
 * `state` and `session` subcommand that accepts an optional `--session-id`.
 *
 * Resolution order, most-specific to least:
 *   1. `explicitId`         — caller passed `--session-id`
 *   2. `OCR_DASHBOARD_EXECUTION_UID` env var → `command_executions.workflow_id`.
 *      Set by the dashboard when it spawns the AI; the SessionCaptureService
 *      binds that uid to the workflow_id once the AI calls `state init`.
 *   3. latest-active fallback — only when exactly one active session exists.
 *      With >1 active sessions and no env var, this throws an ambiguity
 *      error rather than silently picking one. Brittle auto-detect is the
 *      root cause of the "wrong session got closed" failure mode.
 */
export function resolveSession(
  db: Database,
  explicitId?: string,
): ResolveSessionResult {
  // 1. Explicit
  if (explicitId) {
    const s = getSession(db, explicitId);
    if (!s) throw new StateError(STATE_EXIT.NOT_FOUND, `Session not found: ${explicitId}`);
    return {
      id: s.id,
      session_dir: s.session_dir,
      current_round: s.current_round,
      current_map_run: s.current_map_run,
      workflow_type: s.workflow_type,
      status: s.status,
      current_phase: s.current_phase,
      phase_number: s.phase_number,
      branch: s.branch,
      decision: "explicit",
    };
  }

  // 2. Dashboard execution UID
  const uid = process.env["OCR_DASHBOARD_EXECUTION_UID"];
  if (uid) {
    const result = db.exec(
      "SELECT workflow_id FROM command_executions WHERE uid = ?",
      [uid],
    );
    const workflowId = result[0]?.values[0]?.[0] as string | null | undefined;
    if (workflowId) {
      const s = getSession(db, workflowId);
      if (s) {
        return {
          id: s.id,
          session_dir: s.session_dir,
          current_round: s.current_round,
          current_map_run: s.current_map_run,
          workflow_type: s.workflow_type,
          status: s.status,
          current_phase: s.current_phase,
          phase_number: s.phase_number,
          branch: s.branch,
          decision: "dashboard-uid",
        };
      }
    }
    // env var present but no linkage yet (race window before the
    // capture service binds workflow_id). Fall through to latest-active.
  }

  // 3. Latest-active. Refuse if ambiguous.
  const activeRows = db.exec(
    `SELECT id, session_dir, current_round, current_map_run, workflow_type,
            status, current_phase, phase_number, branch
       FROM sessions
      WHERE status = 'active'
      ORDER BY started_at DESC`,
  );
  const rows = activeRows[0]?.values ?? [];
  if (rows.length === 0) throw new StateError(STATE_EXIT.NOT_FOUND, "No active session found");
  if (rows.length > 1) {
    const ids = rows.map((r) => r[0] as string);
    throw new StateError(
      STATE_EXIT.AMBIGUOUS,
      `Ambiguous auto-detect: ${rows.length} active sessions exist. ` +
        `Pass --session-id explicitly. Candidates: ${ids.join(", ")}`,
    );
  }
  const row = rows[0]!;
  return {
    id: row[0] as string,
    session_dir: row[1] as string,
    current_round: row[2] as number,
    current_map_run: row[3] as number,
    workflow_type: row[4] as "review" | "map",
    status: row[5] as SessionStatus,
    current_phase: row[6] as string,
    phase_number: row[7] as number,
    branch: row[8] as string,
    decision: "latest-active",
  };
}

/**
 * Print the auto-detect decision to stderr so a user running a CLI
 * subcommand without `--session-id` sees which session they're acting on.
 * No-op when the caller passed an explicit id — they already know.
 */
export function announceResolveDecision(r: ResolveSessionResult): void {
  if (r.decision === "explicit") return;
  const path =
    r.decision === "dashboard-uid"
      ? "via OCR_DASHBOARD_EXECUTION_UID"
      : "via latest-active";
  console.error(`[ocr] Auto-detected session: ${r.id} (${path})`);
}

/**
 * Backward-compat shim for callers that still take `ocrDir` instead of
 * a Database handle (CLI subcommands in state.ts / session.ts). New code
 * should prefer {@link resolveSession} directly.
 */
export async function resolveActiveSession(
  ocrDir: string,
  explicitId?: string,
): Promise<{ id: string; sessionDir: string; decision: ResolveDecision }> {
  const db = await ensureDatabase(ocrDir);
  const result = resolveSession(db, explicitId);
  announceResolveDecision(result);
  return {
    id: result.id,
    sessionDir: result.session_dir,
    decision: result.decision,
  };
}

// ── Round completion ──

/**
 * Import structured review round data into SQLite.
 *
 * Accepts data from either a file path (`source: "file"`) or a raw JSON
 * string (`source: "stdin"`). Validates the schema, computes derived counts,
 * and writes a `round_completed` orchestration event.
 *
 * When `source` is `"stdin"`, the CLI also writes `round-meta.json` to the
 * correct session round directory — making the CLI the sole writer of all
 * stateful artifacts.
 */
export async function stateRoundComplete(
  params: RoundCompleteParams,
): Promise<RoundCompleteResult> {
  const { ocrDir } = params;
  const db = await ensureDatabase(ocrDir);

  // ── 1. Read and parse JSON ──
  const rawJsonString = readJsonFromSource(params);
  const label = params.source === "file" ? params.filePath : "stdin";
  const raw = parseRawJson(rawJsonString, label);

  // ── 2. Validate and compute counts ──
  const meta = validateRoundMeta(raw);
  const counts = computeRoundCounts(meta);

  // ── 3. Resolve session and round ──
  const session = resolveSession(db, params.sessionId);
  const roundNumber = params.round ?? session.current_round;

  // ── 4. Write round-meta.json when source is stdin ──
  let metaPath: string | undefined;
  if (params.source === "stdin") {
    const roundDir = join(session.session_dir, "rounds", `round-${roundNumber}`);
    mkdirSync(roundDir, { recursive: true });
    metaPath = join(roundDir, "round-meta.json");
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  // ── 5+6. Write the round_completed event and advance current_round
  // atomically, so a reader never sees the event without the round bump
  // (or vice versa).
  db.transaction(() => {
    insertEvent(db, {
      session_id: session.id,
      event_type: "round_completed",
      phase: "synthesis",
      phase_number: 7,
      round: roundNumber,
      metadata: JSON.stringify({
        verdict: meta.verdict,
        blocker_count: counts.blockerCount,
        should_fix_count: counts.shouldFixCount,
        suggestion_count: counts.suggestionCount,
        reviewer_count: counts.reviewerCount,
        total_finding_count: counts.totalFindingCount,
        source: "orchestrator",
      }),
    });

    if (roundNumber >= session.current_round) {
      updateSession(db, session.id, { current_round: roundNumber });
    }
  });

  return { sessionId: session.id, round: roundNumber, metaPath, schema_version: 1 };
}

// ── Map completion ──

/**
 * Import structured map run data into SQLite.
 *
 * Accepts data from either a file path (`source: "file"`) or a raw JSON
 * string (`source: "stdin"`). Validates the schema, computes derived counts,
 * and writes a `map_completed` orchestration event.
 *
 * When `source` is `"stdin"`, the CLI also writes `map-meta.json` to the
 * correct session map run directory — making the CLI the sole writer of all
 * stateful artifacts.
 */
export async function stateMapComplete(
  params: MapCompleteParams,
): Promise<MapCompleteResult> {
  const { ocrDir } = params;
  const db = await ensureDatabase(ocrDir);

  // ── 1. Read and parse JSON ──
  const rawJsonString = readJsonFromSource(params);
  const label = params.source === "file" ? params.filePath : "stdin";
  const raw = parseRawJson(rawJsonString, label);

  // ── 2. Validate and compute counts ──
  const meta = validateMapMeta(raw);
  const counts = computeMapCounts(meta);

  // ── 3. Resolve session and map run ──
  const session = resolveSession(db, params.sessionId);
  const mapRunNumber = params.mapRun ?? session.current_map_run;

  // ── 4. Write map-meta.json when source is stdin ──
  let metaPath: string | undefined;
  if (params.source === "stdin") {
    const runDir = join(session.session_dir, "map", "runs", `run-${mapRunNumber}`);
    mkdirSync(runDir, { recursive: true });
    metaPath = join(runDir, "map-meta.json");
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  // ── 5. Write orchestration event with all data in metadata ──
  // Note: `round` column stores the map run number for map_completed events.
  // This is an intentional schema overload to avoid a separate column.
  db.transaction(() => {
    insertEvent(db, {
      session_id: session.id,
      event_type: "map_completed",
      phase: "synthesis",
      phase_number: 5,
      round: mapRunNumber,
      metadata: JSON.stringify({
        section_count: counts.sectionCount,
        file_count: counts.fileCount,
        source: "orchestrator",
      }),
    });
  });

  return { sessionId: session.id, mapRun: mapRunNumber, metaPath, schema_version: 1 };
}

// ── Atomic porcelain (the misuse-proof agent API) ──

export type BeginResult = {
  schema_version: number;
  session_id: string;
  round: number;
  phase: string;
  completeness: string | null;
};

/**
 * Start or resume a workflow and report where it stands. Thin wrapper over
 * `stateInit` that returns a machine-readable status.
 */
export async function stateBegin(params: InitParams): Promise<BeginResult> {
  const id = await stateInit(params);
  const db = await ensureDatabase(params.ocrDir);
  const s = getSession(db, id);
  return {
    schema_version: 1,
    session_id: id,
    round: s?.current_round ?? 1,
    phase: s?.current_phase ?? "context",
    completeness: getCompletenessState(db, id),
  };
}

export type AdvanceParams = {
  sessionId: string;
  phase: string;
  ocrDir: string;
  round?: number;
  mapRun?: number;
};

/**
 * Advance to a phase. Derives `phase_number` from the phase (no second
 * field to desync) and delegates to the graph-validated `stateTransition`.
 */
export async function stateAdvance(params: AdvanceParams): Promise<void> {
  const db = await ensureDatabase(params.ocrDir);
  const existing = getSession(db, params.sessionId);
  if (!existing) {
    throw new StateError(STATE_EXIT.NOT_FOUND, `Session not found: ${params.sessionId}`);
  }
  const phaseNumber = phaseNumberFor(existing.workflow_type, params.phase);
  // Thread the already-open handle so stateTransition doesn't re-open the DB.
  await stateTransition(
    {
      sessionId: params.sessionId,
      phase: params.phase as ReviewPhase | MapPhase,
      phaseNumber,
      round: params.round,
      mapRun: params.mapRun,
      ocrDir: params.ocrDir,
    },
    db,
  );
}

type CompleteRoundParams = RoundCompleteParams & { requireFinal?: boolean };

/**
 * Atomically finalize a review round: validate the metadata, assert the
 * workflow actually reached `synthesis` (proof the phases were walked),
 * write `round-meta.json`, append the `round_completed` event, advance the
 * round, and transition to `complete` — all-or-nothing. Idempotent: a
 * second call for an already-completed round is a no-op.
 */
export async function stateCompleteRound(
  params: CompleteRoundParams,
): Promise<RoundCompleteResult> {
  const { ocrDir } = params;
  const db = await ensureDatabase(ocrDir);

  // Validate schema (any failure → SCHEMA_INVALID).
  let meta: RoundMeta;
  let counts: SynthesisCounts;
  try {
    const rawJsonString = readJsonFromSource(params);
    const label = params.source === "file" ? params.filePath : "stdin";
    meta = validateRoundMeta(parseRawJson(rawJsonString, label));
    counts = computeRoundCounts(meta);
  } catch (e) {
    throw new StateError(
      STATE_EXIT.SCHEMA_INVALID,
      e instanceof Error ? e.message : "invalid round metadata",
    );
  }

  const resolved = resolveSession(db, params.sessionId);
  const roundNumber = params.round ?? resolved.current_round;
  const roundMetaPath = join(
    resolved.session_dir,
    "rounds",
    `round-${roundNumber}`,
    "round-meta.json",
  );

  // Idempotent: already finalized → no-op success. Return the stable
  // round-meta.json path so callers can't tell an idempotent retry apart
  // from the first write by the absence of metaPath.
  const already = db.exec(
    `SELECT 1 FROM orchestration_events
       WHERE session_id = ? AND event_type = 'round_completed' AND round = ? LIMIT 1`,
    [resolved.id, roundNumber],
  );
  if ((already[0]?.values.length ?? 0) > 0) {
    return { sessionId: resolved.id, round: roundNumber, metaPath: roundMetaPath, schema_version: 1 };
  }

  // Proof of work: the workflow must have reached synthesis. Because every
  // advance is graph-validated, reaching synthesis implies the full path.
  if (resolved.current_phase !== "synthesis") {
    throw new StateError(
      STATE_EXIT.INVARIANT_UNMET,
      `Cannot complete round: workflow is at "${resolved.current_phase}", not "synthesis". ` +
        `Advance through the phases first.`,
    );
  }

  if (params.requireFinal) {
    const finalPath = join(resolved.session_dir, "rounds", `round-${roundNumber}`, "final.md");
    if (!existsSync(finalPath)) {
      throw new StateError(
        STATE_EXIT.INVARIANT_UNMET,
        `Cannot complete round: --require-final set but ${finalPath} is missing.`,
      );
    }
  }

  // Write round-meta.json (stdin mode) before the DB transaction.
  let metaPath: string | undefined;
  if (params.source === "stdin") {
    const roundDir = join(resolved.session_dir, "rounds", `round-${roundNumber}`);
    mkdirSync(roundDir, { recursive: true });
    metaPath = roundMetaPath;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  db.transaction(() => {
    insertEvent(db, {
      session_id: resolved.id,
      event_type: "round_completed",
      phase: "synthesis",
      phase_number: 7,
      round: roundNumber,
      metadata: JSON.stringify({
        verdict: meta.verdict,
        blocker_count: counts.blockerCount,
        should_fix_count: counts.shouldFixCount,
        suggestion_count: counts.suggestionCount,
        reviewer_count: counts.reviewerCount,
        total_finding_count: counts.totalFindingCount,
        source: "orchestrator",
      }),
    });
    if (roundNumber >= resolved.current_round) {
      updateSession(db, resolved.id, { current_round: roundNumber });
    }
    // Transition synthesis → complete (graph-validated).
    validatePhaseTransition("review", resolved.current_phase, "complete", false);
    updateSession(db, resolved.id, { current_phase: "complete", phase_number: 8 });
    insertEvent(db, {
      session_id: resolved.id,
      event_type: "phase_transition",
      phase: "complete",
      phase_number: 8,
      round: roundNumber,
    });
  });

  return { sessionId: resolved.id, round: roundNumber, metaPath, schema_version: 1 };
}

type CompleteMapParams = MapCompleteParams;

/**
 * Atomically finalize a map run: validate metadata, append the
 * `map_completed` event, and transition to `complete`. Idempotent.
 */
export async function stateCompleteMap(
  params: CompleteMapParams,
): Promise<MapCompleteResult> {
  const { ocrDir } = params;
  const db = await ensureDatabase(ocrDir);

  let meta: MapMeta;
  let counts: { sectionCount: number; fileCount: number };
  try {
    const rawJsonString = readJsonFromSource(params);
    const label = params.source === "file" ? params.filePath : "stdin";
    meta = validateMapMeta(parseRawJson(rawJsonString, label));
    counts = computeMapCounts(meta);
  } catch (e) {
    throw new StateError(
      STATE_EXIT.SCHEMA_INVALID,
      e instanceof Error ? e.message : "invalid map metadata",
    );
  }

  const resolved = resolveSession(db, params.sessionId);
  const mapRunNumber = params.mapRun ?? resolved.current_map_run;
  const mapMetaPath = join(
    resolved.session_dir,
    "map",
    "runs",
    `run-${mapRunNumber}`,
    "map-meta.json",
  );

  // Idempotent: already finalized → no-op success. Return the stable
  // map-meta.json path so an idempotent retry looks identical to the first.
  const already = db.exec(
    `SELECT 1 FROM orchestration_events
       WHERE session_id = ? AND event_type = 'map_completed' AND round = ? LIMIT 1`,
    [resolved.id, mapRunNumber],
  );
  if ((already[0]?.values.length ?? 0) > 0) {
    return { sessionId: resolved.id, mapRun: mapRunNumber, metaPath: mapMetaPath, schema_version: 1 };
  }

  if (resolved.current_phase !== "synthesis") {
    throw new StateError(
      STATE_EXIT.INVARIANT_UNMET,
      `Cannot complete map: workflow is at "${resolved.current_phase}", not "synthesis". Advance first.`,
    );
  }

  let metaPath: string | undefined;
  if (params.source === "stdin") {
    const runDir = join(resolved.session_dir, "map", "runs", `run-${mapRunNumber}`);
    mkdirSync(runDir, { recursive: true });
    metaPath = mapMetaPath;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  db.transaction(() => {
    insertEvent(db, {
      session_id: resolved.id,
      event_type: "map_completed",
      phase: "synthesis",
      phase_number: 5,
      round: mapRunNumber,
      metadata: JSON.stringify({
        section_count: counts.sectionCount,
        file_count: counts.fileCount,
        source: "orchestrator",
      }),
    });
    validatePhaseTransition("map", resolved.current_phase, "complete", false);
    updateSession(db, resolved.id, { current_phase: "complete", phase_number: 6 });
    insertEvent(db, {
      session_id: resolved.id,
      event_type: "phase_transition",
      phase: "complete",
      phase_number: 6,
      round: mapRunNumber,
    });
  });

  return { sessionId: resolved.id, mapRun: mapRunNumber, metaPath, schema_version: 1 };
}

// ── Status ──

/**
 * Machine-branchable counterpart to the prose `next_action`. Lets an
 * orchestrating agent dispatch on the next step without parsing English.
 */
export type NextActionKind =
  | "finish"
  | "complete_round"
  | "advance"
  | "wait"
  | "reopen"
  | "none";

export type StatusResult = {
  schema_version: number;
  session_id: string;
  workflow_type: string;
  status: string;
  current_phase: string;
  current_round: number;
  current_map_run: number;
  completeness_state: string | null;
  has_terminal_artifact: boolean;
  marked_closed: boolean;
  dependents_settled: boolean;
  next_action: string;
  next_action_kind: NextActionKind;
};

/**
 * Report whether a session is complete and, if not, the next action — the
 * resume-time "what's missing" query backed by the session_completeness view.
 */
export async function stateStatus(
  ocrDir: string,
  sessionId?: string,
): Promise<StatusResult> {
  const db = await ensureDatabase(ocrDir);
  const resolved = resolveSession(db, sessionId);
  const view = db.exec(
    `SELECT completeness_state, has_terminal_artifact, marked_closed, dependents_settled
       FROM session_completeness WHERE session_id = ?`,
    [resolved.id],
  );
  const row = view[0]?.values[0];
  const completenessState = (row?.[0] as string | undefined) ?? null;
  const hasTerminalArtifact = (row?.[1] as number) === 1;

  let nextAction: string;
  let nextActionKind: NextActionKind;
  switch (completenessState) {
    case "complete":
      nextAction = "none — session is complete";
      nextActionKind = "none";
      break;
    case "closed_without_artifact":
      nextAction =
        "re-open and finalize: this session was closed without a completed round/run";
      nextActionKind = "reopen";
      break;
    case "in_flight":
      nextAction = "wait for in-flight agent processes to finish";
      nextActionKind = "wait";
      break;
    default:
      // Open session. If the current round/run already has its terminal
      // artifact, the next step is to finish; otherwise complete the round.
      if (hasTerminalArtifact) {
        nextAction = "run 'ocr state finish' to close the workflow";
        nextActionKind = "finish";
      } else if (resolved.current_phase === "synthesis") {
        nextAction = "pipe round metadata to 'ocr state complete-round --stdin'";
        nextActionKind = "complete_round";
      } else {
        nextAction = "advance through the phases, then 'ocr state complete-round'";
        nextActionKind = "advance";
      }
  }

  return {
    schema_version: 1,
    session_id: resolved.id,
    workflow_type: resolved.workflow_type,
    status: resolved.status,
    current_phase: resolved.current_phase,
    current_round: resolved.current_round,
    current_map_run: resolved.current_map_run,
    completeness_state: completenessState,
    has_terminal_artifact: hasTerminalArtifact,
    marked_closed: (row?.[2] as number) === 1,
    dependents_settled: (row?.[3] as number) === 1,
    next_action: nextAction,
    next_action_kind: nextActionKind,
  };
}

// ── Filesystem sync ──

/**
 * Sync filesystem sessions into SQLite.
 * Scans .ocr/sessions/ for session directories not yet in SQLite,
 * and backfills them using filesystem metadata (branch from dir name,
 * workflow type from directory structure).
 */
export async function stateSync(ocrDir: string): Promise<number> {
  const db = await ensureDatabase(ocrDir);
  const sessionsRoot = join(ocrDir, "sessions");

  if (!existsSync(sessionsRoot)) {
    return 0;
  }

  const entries = readdirSync(sessionsRoot).filter((name) => {
    const fullPath = join(sessionsRoot, name);
    return statSync(fullPath).isDirectory();
  });

  let synced = 0;

  for (const dirName of entries) {
    const dirPath = join(sessionsRoot, dirName);

    // Check if already in SQLite
    const existing = getSession(db, dirName);
    if (existing) {
      continue;
    }

    // Skip empty sessions — directories with no parseable artifacts (no .md
    // or .json files) are ghost sessions from before structured state management.
    // Registering them creates dashboard noise with no reviewable content.
    if (!hasArtifacts(dirPath)) {
      continue;
    }

    // Derive workflow type from filesystem artifacts
    const hasRoundsDir = existsSync(join(dirPath, "rounds"));
    const hasMapDir = existsSync(join(dirPath, "map"));
    const workflowType = hasMapDir && !hasRoundsDir ? "map" : "review";

    // Extract branch from session ID pattern: YYYY-MM-DD-branch-name
    const branchMatch = dirName.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
    const branch = branchMatch?.[1] ?? dirName;

    // Reconstruct the most-likely terminal state from artifacts.
    // Sessions with a final.md (review) / map.md (map) in their latest
    // round/run are complete; phase_number tracks the workflow's terminal
    // phase index so the dashboard renders the same progress as a session
    // that closed cleanly.
    let inferredPhase = "context";
    let inferredPhaseNumber = 1;
    let inferredRound = 1;
    let inferredMapRun = 1;

    if (workflowType === "review") {
      const roundsDir = join(dirPath, "rounds");
      if (existsSync(roundsDir)) {
        const roundDirs = readdirSync(roundsDir)
          .filter((d) => /^round-\d+$/.test(d))
          .map((d) => parseInt(d.replace("round-", ""), 10))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);
        const latestRoundNum = roundDirs[roundDirs.length - 1];
        if (latestRoundNum !== undefined) {
          inferredRound = latestRoundNum;
          if (
            existsSync(
              join(roundsDir, `round-${latestRoundNum}`, "final.md"),
            )
          ) {
            inferredPhase = "complete";
            inferredPhaseNumber = 8;
          }
        }
      }
    } else if (workflowType === "map") {
      const runsDir = join(dirPath, "map", "runs");
      if (existsSync(runsDir)) {
        const runDirs = readdirSync(runsDir)
          .filter((d) => /^run-\d+$/.test(d))
          .map((d) => parseInt(d.replace("run-", ""), 10))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);
        const latestRunNum = runDirs[runDirs.length - 1];
        if (latestRunNum !== undefined) {
          inferredMapRun = latestRunNum;
          if (
            existsSync(join(runsDir, `run-${latestRunNum}`, "map.md"))
          ) {
            inferredPhase = "complete";
            inferredPhaseNumber = 6;
          }
        }
      }
    }

    insertSession(db, {
      id: dirName,
      branch,
      workflow_type: workflowType,
      current_phase: inferredPhase,
      phase_number: inferredPhaseNumber,
      current_round: inferredRound,
      current_map_run: inferredMapRun,
      session_dir: dirPath,
    });

    // Backfilled sessions are always marked closed — they are filesystem
    // artifacts, not actively running workflows. commitReasonClose writes the
    // session_synced reason event FIRST and the status flip together in one
    // transaction, so the close-guard trigger always sees the reason event.
    commitReasonClose(
      db,
      dirName,
      {
        event_type: "session_synced",
        phase: inferredPhase,
        phase_number: 1,
        metadata: JSON.stringify({ source: "filesystem_backfill" }),
      },
      { status: "closed" },
    );

    synced++;
  }

  return synced;
}
