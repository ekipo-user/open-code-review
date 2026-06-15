/**
 * Round-meta (review round) schema validation and derived-count helpers.
 *
 * Owns the valid finding-category / severity vocabularies, the
 * `validateRoundMeta` schema guard, and `computeRoundCounts`. Depends only on
 * the shared {@link sanitizeMetadataString} helper and the round-meta types —
 * no imports from the state barrel.
 */

import type { RoundMeta } from "./types.js";
import { sanitizeMetadataString } from "./meta-util.js";
import {
  CANONICAL_VERDICTS,
  isCanonicalVerdict,
  deriveCounts,
  resolveRoundCounts,
} from "@open-code-review/platform";

// ── Round-meta validation helpers ──

const VALID_CATEGORIES = new Set(["blocker", "should_fix", "suggestion", "style"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

/**
 * Minimum trimmed length for a finding title. Rejects degenerate titles (e.g.
 * `"s"`) that pass a mere non-empty check but carry no information — the
 * symptom that put `title='s'` rows in the dashboard.
 */
const MIN_TITLE_LEN = 8;

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

  if (typeof obj.verdict !== "string") {
    throw new Error("round-meta.json must contain a verdict string");
  }
  // Strict on vocabulary, tolerant of surrounding whitespace. The verdict is the
  // merge gate only — residual work (follow-ups, suggestions) is carried by
  // finding category, never by a composite verdict. An off-vocabulary value
  // (e.g. `accept_with_followups`) is rejected so the orchestrator self-corrects.
  const verdict = sanitizeMetadataString(obj.verdict).trim();
  if (!isCanonicalVerdict(verdict)) {
    // Echo the RAW value the caller sent (not the sanitized form) so the
    // operator sees exactly what was rejected — matching the title/category/
    // severity error paths below.
    throw new Error(
      `round-meta.json verdict "${String(obj.verdict)}" is not one of: ${CANONICAL_VERDICTS.join(", ")}`,
    );
  }
  obj.verdict = verdict;

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
      if (typeof f.title !== "string" || f.title.trim().length < MIN_TITLE_LEN) {
        throw new Error(
          `Each finding title must be at least ${MIN_TITLE_LEN} characters; got "${String(f.title)}"`,
        );
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

    // Directional cross-check: synthesis_counts are *deduplicated* totals, so a
    // count may be <= the derived per-reviewer tally (cross-reviewer dedup) but
    // can never EXCEED it — you cannot dedup to more than you started with. An
    // inflated count is the "wrong counts" symptom; reject it.
    //
    // Derive-then-compare against the SINGLE shared derivation rule: tally the
    // per-category counts once via the canonical `deriveCounts`, then assert the
    // present synthesis counts don't exceed that tally. No second transcription
    // of the derivation rule lives here (defect D3).
    const allFindings = (obj.reviewers as Array<{ findings: Array<{ category: string }> }>)
      .flatMap((reviewer) => reviewer.findings);
    const derived = deriveCounts(allFindings);
    if (sc.blockers > derived.blocker) {
      throw new Error(
        `synthesis_counts.blockers (${sc.blockers}) exceeds the ${derived.blocker} blocker finding(s) present`,
      );
    }
    if (sc.should_fix > derived.should_fix) {
      throw new Error(
        `synthesis_counts.should_fix (${sc.should_fix}) exceeds the ${derived.should_fix} should_fix finding(s) present`,
      );
    }
    if (sc.suggestions > derived.suggestion) {
      throw new Error(
        `synthesis_counts.suggestions (${sc.suggestions}) exceeds the ${derived.suggestion} suggestion finding(s) present`,
      );
    }
  }

  // Directional verdict <-> blocker-count cross-check. The verdict is the merge
  // gate; it must point the same direction as the blocker count:
  //   APPROVE          => zero blockers (a mergeable gate cannot coexist with a must-fix)
  //   REQUEST CHANGES  => >= 1 blocker  (there must be something to block on)
  //   NEEDS DISCUSSION => unconstrained (undecided pending a human question)
  // The blocker count is the *deduplicated* `resolveRoundCounts().blockerCount`
  // (which honors `synthesis_counts.blockers`), NOT the raw category tally — so a
  // round whose raw blocker findings legitimately dedup to 0 is treated as having
  // 0 blockers, and this check can never contradict the dedup cross-check above.
  const { blockerCount } = resolveRoundCounts(obj as RoundMeta);
  if (verdict === "APPROVE" && blockerCount > 0) {
    throw new Error(
      `round-meta.json verdict "APPROVE" is inconsistent with ${blockerCount} blocker finding(s); ` +
        `APPROVE requires zero blockers (use "REQUEST CHANGES", or carry residual work as should_fix/suggestion/style)`,
    );
  }
  if (verdict === "REQUEST CHANGES" && blockerCount === 0) {
    throw new Error(
      `round-meta.json verdict "REQUEST CHANGES" requires at least one blocker finding; found ${blockerCount} ` +
        `(use "APPROVE" if there is nothing to block on, or "NEEDS DISCUSSION")`,
    );
  }

  return meta as RoundMeta;
}

/**
 * Compute counts for a RoundMeta.
 *
 * Delegates to the SINGLE shared `resolveRoundCounts` rule in
 * `@open-code-review/platform` so the CLI writer and the dashboard reader cannot
 * derive counts differently (defect D3). The rule: prefer the deduplicated
 * `synthesis_counts` when present (they reflect the post-synthesis totals
 * matching `final.md`); otherwise derive each per-category tally from
 * `findings[].category`. `reviewerCount` and `totalFindingCount` are always
 * derived from the data (deduplication does not change them).
 *
 * Note: `style` findings are intentionally included only in `totalFindingCount`
 * and do not have a separate named counter — that omission is documented once at
 * the shared helper, not re-decided here.
 */
export function computeRoundCounts(meta: RoundMeta): {
  blockerCount: number;
  shouldFixCount: number;
  suggestionCount: number;
  reviewerCount: number;
  totalFindingCount: number;
} {
  return resolveRoundCounts(meta);
}
