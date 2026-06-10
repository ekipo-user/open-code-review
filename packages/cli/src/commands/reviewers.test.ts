import { describe, it, expect } from "vitest";
import { validateReviewersMeta } from "./reviewers.js";

function meta(reviewer: Record<string, unknown>) {
  return {
    schema_version: 1,
    generated_at: "2026-06-10T00:00:00.000Z",
    reviewers: [
      {
        id: "architect",
        name: "Architect",
        tier: "holistic",
        description: "System design and boundaries.",
        focus_areas: ["architecture"],
        is_default: true,
        is_builtin: true,
        ...reviewer,
      },
    ],
  };
}

describe("validateReviewersMeta — icon handling (issue #28)", () => {
  it("preserves an explicit icon string", () => {
    const result = validateReviewersMeta(meta({ icon: "blocks" }));
    expect(result.reviewers[0].icon).toBe("blocks");
  });

  it("backfills a missing icon with the canonical default", () => {
    const result = validateReviewersMeta(meta({})); // no icon key
    expect(result.reviewers[0].icon).toBe("blocks"); // architect → blocks
  });

  it("backfills an empty-string icon", () => {
    const result = validateReviewersMeta(meta({ icon: "" }));
    expect(result.reviewers[0].icon).toBe("blocks");
  });

  it("backfills an unknown custom reviewer to 'user'", () => {
    const result = validateReviewersMeta(
      meta({ id: "my-custom", tier: "custom", icon: undefined }),
    );
    expect(result.reviewers[0].icon).toBe("user");
  });

  it("rejects a non-string icon", () => {
    expect(() => validateReviewersMeta(meta({ icon: 42 }))).toThrow(/icon must be a string/);
  });

  it("still rejects genuinely invalid payloads", () => {
    expect(() => validateReviewersMeta(meta({ tier: "bogus" }))).toThrow(/tier/);
    expect(() => validateReviewersMeta(meta({ name: "" }))).toThrow(/name/);
  });
});
