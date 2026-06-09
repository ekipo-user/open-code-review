/**
 * Round-meta (review round) schema validation and derived-count helpers.
 *
 * Owns the valid finding-category / severity vocabularies, the
 * `validateRoundMeta` schema guard, and `computeRoundCounts`. Depends only on
 * the shared {@link sanitizeMetadataString} helper and the round-meta types —
 * no imports from the state barrel.
 */

import type {
  RoundMeta,
  RoundMetaFinding,
} from "./types.js";
import { sanitizeMetadataString } from "./meta-util.js";

// ── Round-meta validation helpers ──

const VALID_CATEGORIES = new Set(["blocker", "should_fix", "suggestion", "style"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

export function validateRoundMeta(meta: unknown): RoundMeta {
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
  obj.verdict = sanitizeMetadataString(obj.verdict);

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
      f.title = sanitizeMetadataString(f.title);
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
      f.summary = sanitizeMetadataString(f.summary);
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
