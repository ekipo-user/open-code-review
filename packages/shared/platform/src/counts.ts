/**
 * The canonical per-round finding-count derivation — the SINGLE source of truth
 * shared by the CLI writer (`computeRoundCounts`, the `synthesis_counts`
 * cross-check) and the dashboard reader (`filesystem-sync`). Defining the rule
 * once is what stops the count representation from drifting between the writer
 * and the reader (defect D3).
 *
 * Bundle hygiene: this module is exported on the Node-free
 * `@open-code-review/platform/counts` subpath (the same discipline as the
 * canonical verdict module) so the browser bundle can import it without pulling
 * `node:*` built-ins through the package barrel.
 *
 * The rule keys off the canonical finding-category vocabulary
 * (`blocker / should_fix / suggestion / style`) — never ad-hoc count-field names
 * or event-metadata keys.
 */

/**
 * The canonical finding categories. Mirrors the CLI's `FindingCategory` union
 * (declared separately in the CLI's state types) without coupling this Node-free
 * module to it.
 */
export const FINDING_CATEGORIES = [
  "blocker",
  "should_fix",
  "suggestion",
  "style",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/**
 * Per-category tally keyed on the canonical category vocabulary.
 *
 * NOTE: `style` is a first-class category here and is tallied by
 * {@link deriveCounts}, but it has no named counter in `synthesis_counts` and is
 * therefore NOT surfaced as a top-level resolved counter — it is folded into
 * `totalFindingCount` only. This omission is documented HERE, once, so it is not
 * "corrected" at a call site by inventing a `styleCount` that the synthesis
 * counts cannot supply.
 */
export type CategoryCounts = {
  blocker: number;
  should_fix: number;
  suggestion: number;
  style: number;
};

/** A finding carrying (at least) a category. Loose by design so both the CLI's
 *  strict `RoundMetaFinding` and the dashboard's optional-field parse satisfy
 *  it. */
export type CountableFinding = {
  category?: string | null;
};

/** The deduplicated, post-synthesis counts the orchestrator may supply. Plural
 *  keys (`blockers`/`suggestions`) are the on-disk `synthesis_counts` spelling;
 *  the helper bridges them to the singular category vocabulary. */
export type CountableSynthesisCounts = {
  blockers?: number;
  should_fix?: number;
  suggestions?: number;
};

/** The round-metadata shape the resolver reads — loose so both the validated
 *  CLI `RoundMeta` and the dashboard's defensive parse satisfy it. */
export type CountableRoundMeta = {
  reviewers?: Array<{ findings?: CountableFinding[] | null } | null> | null;
  synthesis_counts?: CountableSynthesisCounts | null;
};

/** The resolved per-round counts every consumer needs. `blocker/should_fix/
 *  suggestion` honor `synthesis_counts` when present; `reviewerCount` and
 *  `totalFindingCount` are always derived (deduplication does not change them). */
export type ResolvedRoundCounts = {
  blockerCount: number;
  shouldFixCount: number;
  suggestionCount: number;
  reviewerCount: number;
  totalFindingCount: number;
};

/**
 * Tally findings by canonical category. Pure: unknown/absent categories are
 * ignored (they contribute to neither a category tally nor an error), so a
 * malformed finding cannot poison the count.
 */
export function deriveCounts(
  findings: Iterable<CountableFinding>,
): CategoryCounts {
  const counts: CategoryCounts = {
    blocker: 0,
    should_fix: 0,
    suggestion: 0,
    style: 0,
  };
  for (const finding of findings) {
    const category = finding?.category;
    if (
      category === "blocker" ||
      category === "should_fix" ||
      category === "suggestion" ||
      category === "style"
    ) {
      counts[category]++;
    }
  }
  return counts;
}

/** Flatten every reviewer's findings into one array, tolerating absent
 *  reviewers / findings arrays. */
function collectFindings(meta: CountableRoundMeta): CountableFinding[] {
  const all: CountableFinding[] = [];
  for (const reviewer of meta.reviewers ?? []) {
    for (const finding of reviewer?.findings ?? []) all.push(finding);
  }
  return all;
}

/** Prefer a present, finite `synthesis_counts` field; otherwise fall back to the
 *  derived category tally. Validated CLI input (all three numeric) therefore
 *  yields the synthesis_counts verbatim; a partial/legacy payload falls back
 *  per-field — both call sites agree because both run THIS function. */
function preferred(scValue: number | undefined, derivedValue: number): number {
  return typeof scValue === "number" && Number.isFinite(scValue)
    ? scValue
    : derivedValue;
}

/**
 * Resolve the per-round counts under the one canonical rule: **prefer the
 * deduplicated `synthesis_counts` when present; otherwise derive the
 * per-category tally from `findings[].category`.** `reviewerCount` and
 * `totalFindingCount` are always derived from the data.
 *
 * `style` is counted by {@link deriveCounts} and included in
 * `totalFindingCount`, but is intentionally not broken out as its own resolved
 * counter (see {@link CategoryCounts}).
 */
export function resolveRoundCounts(
  meta: CountableRoundMeta,
): ResolvedRoundCounts {
  const allFindings = collectFindings(meta);
  const derived = deriveCounts(allFindings);
  const sc = meta.synthesis_counts ?? undefined;
  return {
    blockerCount: sc ? preferred(sc.blockers, derived.blocker) : derived.blocker,
    shouldFixCount: sc
      ? preferred(sc.should_fix, derived.should_fix)
      : derived.should_fix,
    suggestionCount: sc
      ? preferred(sc.suggestions, derived.suggestion)
      : derived.suggestion,
    reviewerCount: (meta.reviewers ?? []).length,
    totalFindingCount: allFindings.length,
  };
}
