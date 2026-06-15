/**
 * Legacy state reconciliation.
 *
 * Derives true lifecycle state from the event log + filesystem artifacts and
 * repairs the projection, so databases written by pre-v2 OCR (where
 * completion was a mutable flag that could lie) are brought into the
 * event-sourced model. Runs automatically as part of the v12 upgrade and on
 * demand via `ocr state reconcile`.
 *
 * Healing rules, per session:
 *  - closed + terminal artifact event → already correct, skip
 *  - closed + a reason event present  → already accounted for, skip
 *  - closed, no artifact, but a provable `final.md`/`map.md` exists →
 *    SYNTHESIZE the missing `round_completed`/`map_completed` event
 *  - closed, no artifact, not provable → GRANDFATHER via `session_legacy_import`
 *  - active, no events past the threshold, no in-flight dependents →
 *    STALE-CLOSE via `session_auto_closed_stale` (reason event written BEFORE
 *    the status update so the close-guard trigger is satisfied)
 *
 * Idempotent: a second run makes no further changes. `dryRun` collects the
 * plan without writing.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import type { Database } from "./engine.js";
import { getAllSessions, insertEvent, commitReasonClose } from "./queries.js";

const DEFAULT_STALE_THRESHOLD_SECONDS = 7 * 24 * 60 * 60; // 7 days

export type ReconcileKind =
  | "ok"
  | "synthesize-round-completed"
  | "synthesize-map-completed"
  | "grandfather"
  | "stale-close";

export type ReconcileAction = {
  sessionId: string;
  kind: ReconcileKind;
  detail: string;
};

export type ReconcileResult = {
  dryRun: boolean;
  actions: ReconcileAction[];
};

export type ReconcileOptions = {
  dryRun?: boolean;
  staleThresholdSeconds?: number;
};

function hasTerminalArtifactEvent(
  db: Database,
  sessionId: string,
  workflowType: string,
  currentRound: number,
  currentMapRun: number,
): boolean {
  const eventType = workflowType === "map" ? "map_completed" : "round_completed";
  const round = workflowType === "map" ? currentMapRun : currentRound;
  const r = db.exec(
    `SELECT 1 FROM orchestration_events
       WHERE session_id = ? AND event_type = ? AND round = ? LIMIT 1`,
    [sessionId, eventType, round],
  );
  return (r[0]?.values.length ?? 0) > 0;
}

function hasReasonEvent(db: Database, sessionId: string): boolean {
  const r = db.exec(
    `SELECT 1 FROM orchestration_events
       WHERE session_id = ?
         AND event_type IN ('session_aborted','session_auto_closed_stale','session_synced','session_legacy_import')
       LIMIT 1`,
    [sessionId],
  );
  return (r[0]?.values.length ?? 0) > 0;
}

function lastEventAgeSeconds(db: Database, sessionId: string): number | null {
  const r = db.exec(
    `SELECT (julianday('now') - julianday(MAX(created_at))) * 86400
       FROM orchestration_events WHERE session_id = ?`,
    [sessionId],
  );
  const v = r[0]?.values[0]?.[0];
  return typeof v === "number" ? v : null;
}

/**
 * True when a workflow still has at least one `command_executions` row in
 * flight (`finished_at IS NULL`). The single source of truth for "this
 * workflow has not quiesced" — shared by the stale-close path here and by the
 * state layer's `reconcileWorkflowOnExit` (which must NOT close a session
 * while a sibling execution is still running). Keep the predicate in one place
 * so the two reconcilers can never disagree on what "in flight" means.
 */
export function hasInFlightDependents(db: Database, sessionId: string): boolean {
  const r = db.exec(
    `SELECT 1 FROM command_executions
       WHERE workflow_id = ? AND finished_at IS NULL LIMIT 1`,
    [sessionId],
  );
  return (r[0]?.values.length ?? 0) > 0;
}

/** Resolve a possibly-relative `session_dir` against the project root. */
function resolveSessionDir(ocrDir: string, sessionDir: string | null): string | null {
  if (!sessionDir) return null;
  if (isAbsolute(sessionDir)) return sessionDir;
  return join(dirname(ocrDir), sessionDir);
}

export function reconcileLegacyState(
  db: Database,
  ocrDir: string,
  opts: ReconcileOptions = {},
): ReconcileResult {
  const dryRun = opts.dryRun ?? false;
  const threshold = opts.staleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_SECONDS;
  const actions: ReconcileAction[] = [];

  for (const s of getAllSessions(db)) {
    const dir = resolveSessionDir(ocrDir, s.session_dir);

    if (s.status === "closed") {
      if (
        hasTerminalArtifactEvent(db, s.id, s.workflow_type, s.current_round, s.current_map_run) ||
        hasReasonEvent(db, s.id)
      ) {
        continue; // already correct
      }

      // closed_without_artifact — try to heal.
      const reviewFinal =
        s.workflow_type === "review" && dir
          ? existsSync(join(dir, "rounds", `round-${s.current_round}`, "final.md"))
          : false;
      const mapFinal =
        s.workflow_type === "map" && dir
          ? existsSync(join(dir, "map", "runs", `run-${s.current_map_run}`, "map.md"))
          : false;

      if (reviewFinal) {
        actions.push({
          sessionId: s.id,
          kind: "synthesize-round-completed",
          detail: `final.md present for round ${s.current_round}; synthesizing round_completed`,
        });
        if (!dryRun) {
          insertEvent(db, {
            session_id: s.id,
            event_type: "round_completed",
            phase: "synthesis",
            phase_number: 7,
            round: s.current_round,
            metadata: JSON.stringify({ source: "reconciled", synthesized_from: "final.md" }),
          });
        }
      } else if (mapFinal) {
        actions.push({
          sessionId: s.id,
          kind: "synthesize-map-completed",
          detail: `map.md present for run ${s.current_map_run}; synthesizing map_completed`,
        });
        if (!dryRun) {
          insertEvent(db, {
            session_id: s.id,
            event_type: "map_completed",
            phase: "synthesis",
            phase_number: 5,
            round: s.current_map_run,
            metadata: JSON.stringify({ source: "reconciled", synthesized_from: "map.md" }),
          });
        }
      } else {
        actions.push({
          sessionId: s.id,
          kind: "grandfather",
          detail: "no provable artifact; recording session_legacy_import",
        });
        if (!dryRun) {
          insertEvent(db, {
            session_id: s.id,
            event_type: "session_legacy_import",
            phase: "complete",
            metadata: JSON.stringify({ source: "reconciled" }),
          });
        }
      }
      continue;
    }

    // status === 'active' — stale-close if quiet + no in-flight dependents.
    const age = lastEventAgeSeconds(db, s.id);
    const stale =
      (age === null || age > threshold) && !hasInFlightDependents(db, s.id);
    if (stale) {
      actions.push({
        sessionId: s.id,
        kind: "stale-close",
        detail:
          age === null
            ? "active with no events and no in-flight dependents"
            : `active, last event ${Math.round(age / 86400)}d ago, no in-flight dependents`,
      });
      if (!dryRun) {
        // Reason event FIRST (inside one transaction) so the close-guard
        // trigger is satisfied at the status UPDATE. commitReasonClose owns
        // that ordering + atomicity.
        commitReasonClose(
          db,
          s.id,
          {
            event_type: "session_auto_closed_stale",
            phase: "complete",
            metadata: JSON.stringify({ source: "reconciled", threshold_seconds: threshold }),
          },
          { status: "closed", current_phase: "complete" },
        );
      }
    }
  }

  return { dryRun, actions };
}
