/**
 * Phase-progression state machine for both workflow types.
 *
 * Owns the phase → phase_number mapping, the per-workflow transition graphs,
 * and the validation that enforces legal phase movement. Leaf-ish module:
 * depends only on the {@link STATE_EXIT}/{@link StateError} taxonomy from
 * `exit-codes.ts`, never on the state barrel.
 */

import { STATE_EXIT, StateError } from "./exit-codes.js";

/** The two workflow vocabularies have disjoint phase graphs. */
export type WorkflowKind = "review" | "map";

/**
 * Phase → phase_number for each workflow type. Derived so the porcelain
 * `advance` command needs only `--phase` (no desync-prone second field).
 */
export const REVIEW_PHASE_NUMBERS: Record<string, number> = {
  context: 1,
  "change-context": 2,
  analysis: 3,
  reviews: 4,
  aggregation: 5,
  discourse: 6,
  synthesis: 7,
  complete: 8,
};

export const MAP_PHASE_NUMBERS: Record<string, number> = {
  "map-context": 1,
  topology: 2,
  "flow-analysis": 3,
  "requirements-mapping": 4,
  synthesis: 5,
  complete: 6,
};

/**
 * Resolve the phase_number for a phase within a workflow type. Throws an
 * {@link STATE_EXIT.ILLEGAL_TRANSITION} error if the phase is not part of the
 * workflow's vocabulary.
 */
export function phaseNumberFor(
  workflowType: WorkflowKind,
  phase: string,
): number {
  const map = workflowType === "map" ? MAP_PHASE_NUMBERS : REVIEW_PHASE_NUMBERS;
  const n = map[phase];
  if (n === undefined) {
    throw new StateError(
      STATE_EXIT.ILLEGAL_TRANSITION,
      `Invalid phase "${phase}" for workflow_type "${workflowType}". Valid: ${Object.keys(map).join(", ")}`,
    );
  }
  return n;
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

export function graphFor(
  workflowType: WorkflowKind,
): Record<string, ReadonlyArray<string>> {
  return workflowType === "review" ? REVIEW_PHASE_GRAPH : MAP_PHASE_GRAPH;
}

/** The first phase a workflow type legally starts (or restarts) at. */
export function initialPhaseFor(workflowType: WorkflowKind): string {
  return workflowType === "map" ? "map-context" : "context";
}

/**
 * Validate that `target` is a legal next phase given `source` and the
 * workflow's type. Self-loops are always allowed. A round/mapRun bump is a
 * permitted reset, but ONLY back to the workflow's initial phase — a new
 * round legitimately starts over at `context` (review) / `map-context`
 * (map), never partway through. Allowing an arbitrary target on a round
 * boundary would let the AI skip phases under cover of a round bump.
 */
export function validatePhaseTransition(
  workflowType: WorkflowKind,
  source: string,
  target: string,
  isRoundBoundary: boolean,
): void {
  const graph = graphFor(workflowType);
  // Target must belong to this workflow_type's phase vocabulary.
  if (!(target in graph)) {
    const validPhases = Object.keys(graph).join(", ");
    throw new StateError(
      STATE_EXIT.ILLEGAL_TRANSITION,
      `Invalid phase "${target}" for workflow_type "${workflowType}". ` +
        `Valid phases: ${validPhases}`,
    );
  }
  // Same-phase re-entry: always allowed (retries, idempotent calls).
  if (source === target) return;
  // Round/mapRun boundary: a reset is permitted, but only to the initial
  // phase. Anything else on a boundary is an illegal skip.
  if (isRoundBoundary) {
    const initial = initialPhaseFor(workflowType);
    if (target === initial) return;
    throw new StateError(
      STATE_EXIT.ILLEGAL_TRANSITION,
      `Illegal round-boundary transition: a new round/run must reset to ` +
        `"${initial}", not "${target}".`,
    );
  }
  const allowed = graph[source];
  if (!allowed || !allowed.includes(target)) {
    throw new StateError(
      STATE_EXIT.ILLEGAL_TRANSITION,
      `Illegal phase transition: ${source} → ${target}. ` +
        `From "${source}", only ${
          allowed && allowed.length > 0 ? allowed.join(", ") : "(no edges)"
        } are reachable. ` +
        `Pass --current-round to start a new round if the workflow is resetting.`,
    );
  }
}
