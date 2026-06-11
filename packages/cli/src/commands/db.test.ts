import { describe, it, expect } from "vitest";
import { validatePruneBackupsOptions } from "./db.js";

describe("validatePruneBackupsOptions — boundary table (round-2 SF2)", () => {
  // Each case: [label, options, expectRejected]
  const cases: Array<
    [string, { keep: number; force?: boolean; dryRun?: boolean }, boolean]
  > = [
    ["keep 1 (default) is allowed", { keep: 1 }, false],
    ["keep 5 is allowed", { keep: 5 }, false],
    ["keep 0 alone is rejected (removes the safety net)", { keep: 0 }, true],
    ["keep 0 with --force is allowed", { keep: 0, force: true }, false],
    ["keep 0 with --dry-run is allowed (preview)", { keep: 0, dryRun: true }, false],
    // The NaN bypass: `parseInt('oops')` is NaN and `NaN <= 0` is false, so the
    // old guard let a typo delete every backup. Integer validation closes it —
    // including under --force/--dry-run (NaN is never a valid keep).
    ["keep NaN (typo'd flag value) is rejected", { keep: Number.NaN }, true],
    ["keep NaN is rejected even with --force", { keep: Number.NaN, force: true }, true],
    ["keep NaN is rejected even with --dry-run", { keep: Number.NaN, dryRun: true }, true],
    ["keep -1 is rejected", { keep: -1 }, true],
    ["keep 1.5 is rejected (non-integer)", { keep: 1.5 }, true],
    ["keep Infinity is rejected", { keep: Number.POSITIVE_INFINITY }, true],
  ];

  for (const [label, options, expectRejected] of cases) {
    it(label, () => {
      const result = validatePruneBackupsOptions(options);
      if (expectRejected) {
        expect(result).not.toBeNull();
      } else {
        expect(result).toBeNull();
      }
    });
  }
});
