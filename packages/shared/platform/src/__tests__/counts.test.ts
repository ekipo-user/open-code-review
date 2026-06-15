import { describe, it, expect } from "vitest";
import {
  deriveCounts,
  resolveRoundCounts,
  type CountableRoundMeta,
} from "../index.js";

/**
 * The counts module is the single source of truth for per-round finding-count
 * derivation, shared by the CLI writer (`computeRoundCounts`, the
 * `synthesis_counts` cross-check) and the dashboard reader (`filesystem-sync`).
 * These tests pin the canonical rule — prefer the deduplicated
 * `synthesis_counts` when present, else derive per-category from
 * `findings[].category` — and the `style`-omission, and prove that the two
 * historical call sites can no longer drift (they call THIS function).
 */
describe("deriveCounts", () => {
  it("tallies each canonical category, including style", () => {
    expect(
      deriveCounts([
        { category: "blocker" },
        { category: "blocker" },
        { category: "should_fix" },
        { category: "suggestion" },
        { category: "suggestion" },
        { category: "suggestion" },
        { category: "style" },
      ]),
    ).toEqual({ blocker: 2, should_fix: 1, suggestion: 3, style: 1 });
  });

  it("ignores unknown/absent categories without throwing", () => {
    expect(
      deriveCounts([
        { category: "blocker" },
        { category: "nonsense" },
        { category: null },
        {},
      ]),
    ).toEqual({ blocker: 1, should_fix: 0, suggestion: 0, style: 0 });
  });

  it("returns an all-zero tally for an empty input", () => {
    expect(deriveCounts([])).toEqual({
      blocker: 0,
      should_fix: 0,
      suggestion: 0,
      style: 0,
    });
  });
});

describe("resolveRoundCounts", () => {
  const metaWithDupes: CountableRoundMeta = {
    reviewers: [
      {
        findings: [
          { category: "blocker" },
          { category: "should_fix" },
          { category: "suggestion" },
          { category: "style" },
        ],
      },
      {
        // Same blocker re-flagged by a second reviewer (a duplicate).
        findings: [{ category: "blocker" }, { category: "suggestion" }],
      },
    ],
  };

  it("prefers synthesis_counts (deduplicated) when present", () => {
    const meta: CountableRoundMeta = {
      ...metaWithDupes,
      // One unique blocker after dedup, even though two were flagged.
      synthesis_counts: { blockers: 1, should_fix: 1, suggestions: 2 },
    };
    const counts = resolveRoundCounts(meta);
    expect(counts.blockerCount).toBe(1);
    expect(counts.shouldFixCount).toBe(1);
    expect(counts.suggestionCount).toBe(2);
    // reviewerCount / totalFindingCount are always derived, never deduplicated.
    expect(counts.reviewerCount).toBe(2);
    expect(counts.totalFindingCount).toBe(6);
  });

  it("derives per-category from findings when synthesis_counts is absent", () => {
    const counts = resolveRoundCounts(metaWithDupes);
    // Derived (raw) tallies: two blockers, two suggestions.
    expect(counts.blockerCount).toBe(2);
    expect(counts.shouldFixCount).toBe(1);
    expect(counts.suggestionCount).toBe(2);
    expect(counts.reviewerCount).toBe(2);
    expect(counts.totalFindingCount).toBe(6);
  });

  it("folds style into totalFindingCount but never breaks it out as a named counter", () => {
    const counts = resolveRoundCounts({
      reviewers: [{ findings: [{ category: "style" }, { category: "style" }] }],
    });
    expect(counts.blockerCount).toBe(0);
    expect(counts.shouldFixCount).toBe(0);
    expect(counts.suggestionCount).toBe(0);
    expect(counts.totalFindingCount).toBe(2);
    expect("styleCount" in counts).toBe(false);
  });

  it("tolerates absent reviewers / findings arrays", () => {
    expect(resolveRoundCounts({})).toEqual({
      blockerCount: 0,
      shouldFixCount: 0,
      suggestionCount: 0,
      reviewerCount: 0,
      totalFindingCount: 0,
    });
    expect(resolveRoundCounts({ reviewers: [null, { findings: null }] })).toEqual(
      {
        blockerCount: 0,
        shouldFixCount: 0,
        suggestionCount: 0,
        reviewerCount: 2,
        totalFindingCount: 0,
      },
    );
  });

  it("falls back per-field when a synthesis_counts field is absent", () => {
    // Defensive: a partial synthesis_counts (only blockers set) uses the derived
    // tally for the missing fields rather than reporting zero.
    const counts = resolveRoundCounts({
      reviewers: [
        { findings: [{ category: "should_fix" }, { category: "suggestion" }] },
      ],
      synthesis_counts: { blockers: 0 },
    });
    expect(counts.blockerCount).toBe(0);
    expect(counts.shouldFixCount).toBe(1);
    expect(counts.suggestionCount).toBe(1);
  });

  it("pins CLI/dashboard parity: identical metadata yields identical counts", () => {
    // Both the CLI writer (computeRoundCounts) and the dashboard reader
    // (filesystem-sync inline) now call resolveRoundCounts. Re-resolving the
    // same metadata must be referentially identical — the contract that closes
    // the drift between writer and reader (defect D3).
    const meta: CountableRoundMeta = {
      reviewers: [
        { findings: [{ category: "blocker" }, { category: "style" }] },
        { findings: [{ category: "suggestion" }] },
      ],
      synthesis_counts: { blockers: 1, should_fix: 0, suggestions: 1 },
    };
    expect(resolveRoundCounts(meta)).toEqual(resolveRoundCounts(meta));
  });
});
