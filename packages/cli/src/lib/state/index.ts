/**
 * OCR State Management Module
 *
 * Manages session state exclusively through SQLite (.ocr/data/ocr.db).
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
  saveDatabase,
  insertSession,
  updateSession,
  getSession,
  getLatestActiveSession,
  getAllSessions,
  insertEvent,
  getEventsForSession,
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
  RoundMetaFinding,
  SynthesisCounts,
  MapCompleteParams,
  MapCompleteResult,
  MapMeta,
} from "./types.js";

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

// ── Helpers ──

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
 * Initialize a session in SQLite.
 *
 * If the session already exists (e.g. round-1 completed and closed),
 * re-opens it for the next round instead of failing silently on the
 * UNIQUE constraint.
 */
export async function stateInit(params: InitParams): Promise<string> {
  const { sessionId, branch, workflowType, sessionDir, ocrDir } = params;
  const db = await ensureDatabase(ocrDir);
  const dbPath = join(ocrDir, "data", "ocr.db");

  const existing = getSession(db, sessionId);

  if (existing) {
    // Workflow type compatibility: re-opening with a different type would
    // corrupt phase semantics (review vs map have disjoint phase graphs).
    if (existing.workflow_type !== workflowType) {
      throw new Error(
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

    // Re-open the session for the next round
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

    saveDatabase(db, dbPath);
    return sessionId;
  }

  const initialPhase = workflowType === "map" ? "map-context" : "context";

  // New session — original path
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

  saveDatabase(db, dbPath);

  return sessionId;
}

/**
 * Phase-progression graphs. Each entry maps a phase to the set of phases
 * legally reachable from it. Self-loops (idempotent re-entry of the same
 * phase) are always allowed and don't need to appear in the map.
 *
 * `complete` loops back to the initial phase to allow a new round/run.
 *
 * Why enforce this: without a transition graph, the AI could jump from
 * `reviews` straight to `complete`, skipping aggregation/discourse/
 * synthesis. The dashboard's outcome derivation (sessions.status) would
 * still mark the workflow closed, masking the gap. Treating the phase
 * sequence as a state machine makes that class of bug impossible.
 */
const REVIEW_PHASE_GRAPH: Record<string, ReadonlyArray<string>> = {
  context: ["change-context"],
  "change-context": ["analysis"],
  analysis: ["reviews"],
  reviews: ["aggregation"],
  aggregation: ["discourse"],
  discourse: ["synthesis"],
  synthesis: ["complete"],
  complete: ["context"],
};

const MAP_PHASE_GRAPH: Record<string, ReadonlyArray<string>> = {
  "map-context": ["topology"],
  topology: ["flow-analysis"],
  "flow-analysis": ["requirements-mapping"],
  "requirements-mapping": ["synthesis"],
  synthesis: ["complete"],
  complete: ["map-context"],
};

function graphFor(
  workflowType: "review" | "map",
): Record<string, ReadonlyArray<string>> {
  return workflowType === "review" ? REVIEW_PHASE_GRAPH : MAP_PHASE_GRAPH;
}

/**
 * Validate that `target` is a legal next phase given `source` and the
 * workflow's type. Self-loops are always allowed. Round/mapRun bumps
 * are treated as a permitted reset back to the first phase regardless
 * of source (a new round legitimately starts over at `context`).
 */
function validatePhaseTransition(
  workflowType: "review" | "map",
  source: string,
  target: string,
  isRoundBoundary: boolean,
): void {
  const graph = graphFor(workflowType);
  // Target must belong to this workflow_type's phase vocabulary.
  if (!(target in graph)) {
    const validPhases = Object.keys(graph).join(", ");
    throw new Error(
      `Invalid phase "${target}" for workflow_type "${workflowType}". ` +
        `Valid phases: ${validPhases}`,
    );
  }
  // Same-phase re-entry: always allowed (retries, idempotent calls).
  if (source === target) return;
  // Round/mapRun boundary: any phase of the same workflow is reachable.
  if (isRoundBoundary) return;
  const allowed = graph[source];
  if (!allowed || !allowed.includes(target)) {
    throw new Error(
      `Illegal phase transition: ${source} → ${target}. ` +
        `From "${source}", only ${
          allowed && allowed.length > 0 ? allowed.join(", ") : "(no edges)"
        } are reachable. ` +
        `Pass --current-round to start a new round if the workflow is resetting.`,
    );
  }
}

/**
 * Transition a session to a new phase in SQLite.
 */
export async function stateTransition(params: TransitionParams): Promise<void> {
  const { sessionId, phase, phaseNumber, round, mapRun, ocrDir } = params;
  const db = await ensureDatabase(ocrDir);
  const dbPath = join(ocrDir, "data", "ocr.db");

  const existing = getSession(db, sessionId);
  if (!existing) {
    throw new Error(`Session not found: ${sessionId}`);
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

  saveDatabase(db, dbPath);
}

/** Sentinel exit code stamped on dependent rows cascade-closed by a
 *  parent stateClose. Distinct from -2 (user cancel) and -3 (orphaned by
 *  liveness sweep) so triage can tell the cause apart. */
const CASCADE_CLOSE_EXIT_CODE = -4;

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
  const { sessionId, ocrDir } = params;
  const db = await ensureDatabase(ocrDir);
  const dbPath = join(ocrDir, "data", "ocr.db");

  const existing = getSession(db, sessionId);
  if (!existing) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (existing.status === "closed") {
    // Idempotent no-op. Caller still gets a clean exit; the stderr
    // notice tells them their action had no effect — useful when the AI
    // accidentally retries close after a successful first attempt.
    console.error(`[ocr] Session already closed: ${sessionId}`);
    return;
  }

  updateSession(db, sessionId, {
    status: "closed",
    current_phase: "complete",
  });

  insertEvent(db, {
    session_id: sessionId,
    event_type: "session_closed",
    phase: "complete",
    phase_number: existing.phase_number,
    round: existing.current_round,
  });

  // Cascade: terminate any dependent command_executions rows still in
  // flight. Without this, a workflow close leaves orphan rows that only
  // the heartbeat sweep can recover — and that sweep needs the dashboard
  // running. Doing it here makes close authoritative.
  const note = "closed by parent workflow close";
  db.run(
    `UPDATE command_executions
       SET finished_at = datetime('now'),
           exit_code   = ?,
           pid         = NULL,
           notes       = COALESCE(notes || char(10), '') || ?
     WHERE workflow_id = ?
       AND finished_at IS NULL`,
    [CASCADE_CLOSE_EXIT_CODE, note, sessionId],
  );

  saveDatabase(db, dbPath);
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
    if (!s) throw new Error(`Session not found: ${explicitId}`);
    return {
      id: s.id,
      session_dir: s.session_dir,
      current_round: s.current_round,
      current_map_run: s.current_map_run,
      workflow_type: s.workflow_type,
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
          decision: "dashboard-uid",
        };
      }
    }
    // env var present but no linkage yet (race window before the
    // capture service binds workflow_id). Fall through to latest-active.
  }

  // 3. Latest-active. Refuse if ambiguous.
  const activeRows = db.exec(
    `SELECT id, session_dir, current_round, current_map_run, workflow_type
       FROM sessions
      WHERE status = 'active'
      ORDER BY started_at DESC`,
  );
  const rows = activeRows[0]?.values ?? [];
  if (rows.length === 0) throw new Error("No active session found");
  if (rows.length > 1) {
    const ids = rows.map((r) => r[0] as string);
    throw new Error(
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

// ── Shared completion helpers ──

/**
 * Read raw JSON string from either a file path or a raw data string.
 */
function readJsonFromSource(
  params: { source: "file"; filePath: string } | { source: "stdin"; data: string },
): string {
  if (params.source === "file") {
    if (!existsSync(params.filePath)) {
      throw new Error(`File not found: ${params.filePath}`);
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
    throw new Error(
      `Failed to parse ${label}: ${err instanceof Error ? err.message : "invalid JSON"}`,
    );
  }
}


// ── Round-meta validation helpers ──

const VALID_CATEGORIES = new Set(["blocker", "should_fix", "suggestion", "style"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

function validateRoundMeta(meta: unknown): RoundMeta {
  if (!meta || typeof meta !== "object") {
    throw new Error("round-meta.json must be a JSON object");
  }

  const obj = meta as Record<string, unknown>;

  if (obj.schema_version !== 1) {
    throw new Error(
      `Unsupported schema_version: ${String(obj.schema_version)}. Expected 1.`,
    );
  }

  if (typeof obj.verdict !== "string" || obj.verdict.trim().length === 0) {
    throw new Error("round-meta.json must contain a non-empty verdict string");
  }

  if (!Array.isArray(obj.reviewers)) {
    throw new Error("round-meta.json must contain a reviewers array");
  }

  for (const reviewer of obj.reviewers) {
    if (!reviewer || typeof reviewer !== "object") {
      throw new Error("Each reviewer must be an object");
    }
    const r = reviewer as Record<string, unknown>;
    if (typeof r.type !== "string") {
      throw new Error("Each reviewer must have a type string");
    }
    if (typeof r.instance !== "number") {
      throw new Error("Each reviewer must have an instance number");
    }
    if (!Array.isArray(r.findings)) {
      throw new Error(`Reviewer ${r.type}-${r.instance} must have a findings array`);
    }
    for (const finding of r.findings) {
      if (!finding || typeof finding !== "object") {
        throw new Error("Each finding must be an object");
      }
      const f = finding as Record<string, unknown>;
      if (typeof f.title !== "string" || f.title.trim().length === 0) {
        throw new Error("Each finding must have a non-empty title");
      }
      if (typeof f.category !== 'string' || !VALID_CATEGORIES.has(f.category)) {
        throw new Error(
          `Finding "${f.title}" has invalid category: "${String(f.category)}". Must be one of: ${[...VALID_CATEGORIES].join(", ")}`,
        );
      }
      if (typeof f.severity !== 'string' || !VALID_SEVERITIES.has(f.severity)) {
        throw new Error(
          `Finding "${f.title}" has invalid severity: "${String(f.severity)}". Must be one of: ${[...VALID_SEVERITIES].join(", ")}`,
        );
      }
      if (typeof f.summary !== "string") {
        throw new Error(`Finding "${f.title}" must have a summary string`);
      }
      if (f.file_path !== undefined && typeof f.file_path !== "string") {
        throw new Error(`Finding "${f.title}" has invalid file_path: expected string`);
      }
      if (f.line_start !== undefined && typeof f.line_start !== "number") {
        throw new Error(`Finding "${f.title}" has invalid line_start: expected number`);
      }
      if (f.line_end !== undefined && typeof f.line_end !== "number") {
        throw new Error(`Finding "${f.title}" has invalid line_end: expected number`);
      }
      if (f.flagged_by !== undefined && !Array.isArray(f.flagged_by)) {
        throw new Error(`Finding "${f.title}" has invalid flagged_by: expected array`);
      }
    }
  }

  // Validate optional synthesis_counts
  if (obj.synthesis_counts !== undefined) {
    if (!obj.synthesis_counts || typeof obj.synthesis_counts !== "object") {
      throw new Error("synthesis_counts must be an object");
    }
    const sc = obj.synthesis_counts as Record<string, unknown>;
    if (typeof sc.blockers !== "number" || sc.blockers < 0) {
      throw new Error("synthesis_counts.blockers must be a non-negative number");
    }
    if (typeof sc.should_fix !== "number" || sc.should_fix < 0) {
      throw new Error("synthesis_counts.should_fix must be a non-negative number");
    }
    if (typeof sc.suggestions !== "number" || sc.suggestions < 0) {
      throw new Error("synthesis_counts.suggestions must be a non-negative number");
    }
  }

  return meta as RoundMeta;
}

/**
 * Compute counts for a RoundMeta.
 *
 * When `synthesis_counts` is present, those values are preferred because they
 * reflect the **deduplicated, post-synthesis** totals matching `final.md`.
 * The per-reviewer findings array can contain duplicates (the same issue
 * flagged by multiple reviewers), so derived counts may exceed the actual
 * number of unique items in the synthesis.
 *
 * `reviewerCount` and `totalFindingCount` are always derived from the data
 * (they aren't affected by deduplication).
 *
 * Note: `style` findings are intentionally included only in `totalFindingCount`
 * and do not have a separate named counter. The dashboard displays them as part
 * of the total but does not break them out in summary cards.
 */
export function computeRoundCounts(meta: RoundMeta): {
  blockerCount: number;
  shouldFixCount: number;
  suggestionCount: number;
  reviewerCount: number;
  totalFindingCount: number;
} {
  const allFindings: RoundMetaFinding[] = [];
  for (const reviewer of meta.reviewers) {
    allFindings.push(...reviewer.findings);
  }

  // Prefer explicit synthesis counts (deduplicated) over derived counts
  const sc = meta.synthesis_counts;

  return {
    blockerCount: sc ? sc.blockers : allFindings.filter((f) => f.category === "blocker").length,
    shouldFixCount: sc ? sc.should_fix : allFindings.filter((f) => f.category === "should_fix").length,
    suggestionCount: sc ? sc.suggestions : allFindings.filter((f) => f.category === "suggestion").length,
    reviewerCount: meta.reviewers.length,
    totalFindingCount: allFindings.length,
  };
}

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
  const dbPath = join(ocrDir, "data", "ocr.db");

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

  // ── 5. Write orchestration event with all data in metadata ──
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

  // ── 6. Advance current_round on the session row. Without this, the
  // sessions table lags the events log — the next stateInit re-open
  // would have to re-derive round each time. Keeping the column in
  // sync with the event log lets the dashboard read it directly.
  if (roundNumber >= session.current_round) {
    updateSession(db, session.id, { current_round: roundNumber });
  }

  saveDatabase(db, dbPath);

  return { sessionId: session.id, round: roundNumber, metaPath };
}

// ── Map-meta validation helpers ──

function validateMapMeta(meta: unknown): MapMeta {
  if (!meta || typeof meta !== "object") {
    throw new Error("map-meta.json must be a JSON object");
  }

  const obj = meta as Record<string, unknown>;

  if (obj.schema_version !== 1) {
    throw new Error(
      `Unsupported schema_version: ${String(obj.schema_version)}. Expected 1.`,
    );
  }

  if (!Array.isArray(obj.sections)) {
    throw new Error("map-meta.json must contain a sections array");
  }

  for (const section of obj.sections) {
    if (!section || typeof section !== "object") {
      throw new Error("Each section must be an object");
    }
    const s = section as Record<string, unknown>;
    if (typeof s.section_number !== "number") {
      throw new Error("Each section must have a section_number");
    }
    if (typeof s.title !== "string" || s.title.trim().length === 0) {
      throw new Error("Each section must have a non-empty title");
    }
    if (!Array.isArray(s.files)) {
      throw new Error(`Section "${s.title}" must have a files array`);
    }
    for (const file of s.files) {
      if (!file || typeof file !== "object") {
        throw new Error("Each file must be an object");
      }
      const f = file as Record<string, unknown>;
      if (typeof f.file_path !== "string" || f.file_path.trim().length === 0) {
        throw new Error("Each file must have a non-empty file_path");
      }
      if (typeof f.role !== "string") {
        throw new Error(`File "${f.file_path}" must have a role string`);
      }
      if (typeof f.lines_added !== "number") {
        throw new Error(`File "${f.file_path}" must have a lines_added number`);
      }
      if (typeof f.lines_deleted !== "number") {
        throw new Error(`File "${f.file_path}" must have a lines_deleted number`);
      }
    }
  }

  if (obj.dependencies !== undefined && !Array.isArray(obj.dependencies)) {
    throw new Error("map-meta.json dependencies must be an array if provided");
  }

  return meta as MapMeta;
}

/**
 * Compute derived counts from the sections array in a MapMeta.
 * Counts are NEVER self-reported — always derived from the data.
 */
export function computeMapCounts(meta: MapMeta): {
  sectionCount: number;
  fileCount: number;
} {
  return {
    sectionCount: meta.sections.length,
    fileCount: meta.sections.reduce((sum, s) => sum + s.files.length, 0),
  };
}

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
  const dbPath = join(ocrDir, "data", "ocr.db");

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

  saveDatabase(db, dbPath);

  return { sessionId: session.id, mapRun: mapRunNumber, metaPath };
}

/**
 * Sync filesystem sessions into SQLite.
 * Scans .ocr/sessions/ for session directories not yet in SQLite,
 * and backfills them using filesystem metadata (branch from dir name,
 * workflow type from directory structure).
 */
export async function stateSync(ocrDir: string): Promise<number> {
  const db = await ensureDatabase(ocrDir);
  const dbPath = join(ocrDir, "data", "ocr.db");
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
    // artifacts, not actively running workflows. Active sessions are
    // created by stateInit, not by filesystem backfill.
    updateSession(db, dirName, { status: "closed" });

    insertEvent(db, {
      session_id: dirName,
      event_type: "session_synced",
      phase: inferredPhase,
      phase_number: 1,
      metadata: JSON.stringify({ source: "filesystem_backfill" }),
    });

    synced++;
  }

  if (synced > 0) {
    saveDatabase(db, dbPath);
  }

  return synced;
}
