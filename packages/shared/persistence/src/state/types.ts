/**
 * Types for OCR state management.
 */

import type { CanonicalVerdict } from "@open-code-review/platform";

export type WorkflowType = "review" | "map";

export type SessionStatus = "active" | "closed";

export type ReviewPhase =
  | "context"
  | "change-context"
  | "analysis"
  | "reviews"
  | "aggregation"
  | "discourse"
  | "synthesis"
  | "complete";

export type MapPhase =
  | "map-context"
  | "topology"
  | "flow-analysis"
  | "requirements-mapping"
  | "synthesis"
  | "complete";

export type InitParams = {
  sessionId: string;
  branch: string;
  workflowType: WorkflowType;
  sessionDir: string;
  ocrDir: string;
};

export type TransitionParams = {
  sessionId: string;
  phase: ReviewPhase | MapPhase;
  phaseNumber: number;
  round?: number;
  mapRun?: number;
  ocrDir: string;
};

export type CloseParams = {
  sessionId: string;
  ocrDir: string;
  /**
   * Abandon the session instead of completing it. Records a distinct
   * `session_aborted` terminal event (never reported as success) and
   * bypasses the completion invariant.
   */
  abort?: boolean;
};

// ── Round Meta (orchestrator-first structured data) ──

export type FindingCategory = "blocker" | "should_fix" | "suggestion" | "style";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type RoundMetaFinding = {
  title: string;
  category: FindingCategory;
  severity: FindingSeverity;
  file_path?: string;
  line_start?: number;
  line_end?: number;
  summary: string;
  flagged_by?: string[];
};

export type RoundMetaReviewer = {
  type: string;
  instance: number;
  /** Informational — not used for counting. Counts are derived from findings[].category. */
  severity_high?: number;
  /** Informational — not used for counting. */
  severity_medium?: number;
  /** Informational — not used for counting. */
  severity_low?: number;
  /** Informational — not used for counting. */
  severity_info?: number;
  findings: RoundMetaFinding[];
};

/**
 * Explicit post-synthesis counts set by the orchestrator.
 * These reflect the deduplicated, final counts from `final.md` and take
 * precedence over the per-reviewer derived counts (which double-count
 * findings flagged by multiple reviewers).
 */
export type SynthesisCounts = {
  blockers: number;
  should_fix: number;
  suggestions: number;
};

export type RoundMeta = {
  schema_version: number;
  // The write-boundary verdict is always one of the canonical 3 states —
  // `validateRoundMeta` is the only producer of a RoundMeta and rejects anything
  // off-vocabulary (exit 7). Encoding that in the type makes any future write
  // path that bypasses validation a compile error. (The READ boundary — DB DTOs
  // like `latest_verdict` — stays `string` for legacy tolerance.)
  verdict: CanonicalVerdict;
  reviewers: RoundMetaReviewer[];
  /** Post-synthesis counts matching final.md. Preferred over derived counts. */
  synthesis_counts?: SynthesisCounts;
};

export type RoundCompleteParams =
  | {
      source: "file";
      ocrDir: string;
      sessionId?: string;
      round?: number;
      filePath: string;
    }
  | {
      source: "stdin";
      ocrDir: string;
      sessionId?: string;
      round?: number;
      data: string;
    };

export type RoundCompleteResult = {
  sessionId: string;
  round: number;
  /**
   * Canonical on-disk location of `round-meta.json` for this round. It is the
   * path the CLI owns — not a guarantee the file currently exists (a caller
   * that deletes it between an initial call and an idempotent retry will get
   * the same canonical path back).
   */
  metaPath?: string;
  /** Result envelope version so consumers can branch on schema changes. */
  schema_version: number;
};

// ── Map Meta (structured map data) ──

export type MapMetaFile = {
  file_path: string;
  role: string;
  lines_added: number;
  lines_deleted: number;
};

export type MapMetaSection = {
  section_number: number;
  title: string;
  description?: string;
  files: MapMetaFile[];
};

export type MapMetaDependency = {
  from_section: number;
  from_title: string;
  to_section: number;
  to_title: string;
  relationship: string;
};

export type MapMeta = {
  schema_version: number;
  sections: MapMetaSection[];
  dependencies?: MapMetaDependency[];
};

export type MapCompleteParams =
  | {
      source: "file";
      ocrDir: string;
      sessionId?: string;
      mapRun?: number;
      filePath: string;
    }
  | {
      source: "stdin";
      ocrDir: string;
      sessionId?: string;
      mapRun?: number;
      data: string;
    };

export type MapCompleteResult = {
  sessionId: string;
  mapRun: number;
  metaPath?: string;
  /** Result envelope version so consumers can branch on schema changes. */
  schema_version: number;
};

// ── Reviewers Meta (structured reviewer catalog for dashboard) ──

export type ReviewerTier = "holistic" | "specialist" | "persona" | "custom";

export type ReviewerMeta = {
  id: string;
  name: string;
  tier: ReviewerTier;
  icon: string;
  description: string;
  focus_areas: string[];
  is_default: boolean;
  is_builtin: boolean;
  known_for?: string;
  philosophy?: string;
};

export type ReviewersMeta = {
  schema_version: number;
  generated_at: string;
  reviewers: ReviewerMeta[];
};

// ── Agent Sessions (per-instance lifecycle journal) ──

export type AgentSessionStatus =
  | "spawning"
  | "running"
  | "done"
  | "crashed"
  | "cancelled"
  | "orphaned";

/** The vendors OCR ships first-class support for. */
export type KnownAgentVendor = "claude" | "opencode" | "gemini";

/**
 * A vendor identifier. Unknown vendors are accepted (the field is open), but
 * the `string & {}` intersection keeps editor autocomplete for the known
 * vendors instead of collapsing the union to a bare `string`.
 */
export type AgentVendor = KnownAgentVendor | (string & {});

/**
 * The role a `command_executions` row plays — derived (never stored) from the
 * always-present `command` + `last_heartbeat_at` columns:
 *   - `supervisor` — a workflow-owning process (a dashboard-spawned `ocr
 *     review`/`map`); its death cascade-terminates its dependents.
 *   - `instance`   — a reviewer instance journaled via `ocr session
 *     start-instance` (a dependent; never owns a workflow's lifecycle).
 *   - `utility`    — a fire-and-forget command with no journaled heartbeat.
 */
export type RowKind = "supervisor" | "instance" | "utility";

/**
 * One row in the `agent_sessions` table — a journal entry for an agent-CLI
 * process the AI declared it spawned on behalf of a workflow.
 */
export type AgentSession = {
  id: string;
  workflow_id: string;
  vendor: AgentVendor;
  vendor_session_id: string | null;
  persona: string | null;
  instance_index: number | null;
  name: string | null;
  resolved_model: string | null;
  phase: string | null;
  status: AgentSessionStatus;
  /** Derived process role — lets a consumer confidently tell what kind of
   *  process this row represents without parsing the command string. */
  kind: RowKind;
  pid: number | null;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  exit_code: number | null;
  notes: string | null;
};

// ── Show Result ──

export type ShowResult = {
  session: {
    id: string;
    branch: string;
    status: SessionStatus;
    workflow_type: WorkflowType;
    current_phase: string;
    phase_number: number;
    current_round: number;
    current_map_run: number;
    started_at: string;
    updated_at: string;
  };
  events: Array<{
    id: number;
    event_type: string;
    phase: string | null;
    phase_number: number | null;
    round: number | null;
    metadata: string | null;
    created_at: string;
  }>;
};
