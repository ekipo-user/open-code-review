/**
 * Hermetic tests for the vendor model-listing strategy table.
 *
 * `execBinaryAsync` is mocked — the previous version of this suite ran
 * whatever real CLIs existed on the machine, which made it pass identically
 * for native and bundled output and let the issue-#39 regression hide.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@open-code-review/platform", () => ({
  execBinaryAsync: vi.fn(),
}));

import { execBinaryAsync } from "@open-code-review/platform";
import {
  clearModelListCache,
  detectActiveVendor,
  isModelVendor,
  listModelsForVendor,
  parseOpenCodeModelList,
  SUPPORTED_VENDORS,
  VENDOR_MODEL_STRATEGIES,
} from "../models.js";

const execMock = vi.mocked(execBinaryAsync);

function resolveWith(stdout: string): void {
  execMock.mockResolvedValue({ stdout, stderr: "" });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearModelListCache();
});

describe("parseOpenCodeModelList", () => {
  it("parses newline-delimited provider/model ids with provider extraction", () => {
    const parsed = parseOpenCodeModelList(
      "anthropic/claude-sonnet-4-6\nopencode/big-pickle\n",
    );
    expect(parsed).toEqual([
      { id: "anthropic/claude-sonnet-4-6", provider: "anthropic" },
      { id: "opencode/big-pickle", provider: "opencode" },
    ]);
  });

  it("tolerates CRLF line endings and surrounding whitespace", () => {
    const parsed = parseOpenCodeModelList(
      "anthropic/claude-opus-4-8\r\n  opencode/big-pickle  \r\n",
    );
    expect(parsed?.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4-8",
      "opencode/big-pickle",
    ]);
  });

  it("skips lines that are not bare provider-prefixed ids", () => {
    const parsed = parseOpenCodeModelList(
      [
        "Fetching models...",
        "",
        "anthropic/claude-sonnet-4-6",
        "WARN something happened",
        "not-an-id",
      ].join("\n"),
    );
    expect(parsed?.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("returns null (failure, not empty success) when no line matches", () => {
    expect(parseOpenCodeModelList("")).toBeNull();
    expect(parseOpenCodeModelList("error: kaboom\nplain text")).toBeNull();
  });

  it("keeps multi-slash ids (openrouter-style) — slash count is not constrained", () => {
    const parsed = parseOpenCodeModelList("openrouter/meta-llama/llama-3\n");
    expect(parsed).toEqual([
      { id: "openrouter/meta-llama/llama-3", provider: "openrouter" },
    ]);
  });

  it("rejects URL-shaped noise (colon in the provider segment)", () => {
    expect(
      parseOpenCodeModelList("https://opencode.ai/docs\nhttp://x/y\n"),
    ).toBeNull();
  });
});

describe("listModelsForVendor — opencode (native probe)", () => {
  it("shells exactly `opencode models` — the wire the --json regression broke", async () => {
    resolveWith("anthropic/claude-sonnet-4-6\n");
    await listModelsForVendor("opencode");
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith(
      "opencode",
      ["models"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("returns native ids with source 'native' on probe success", async () => {
    resolveWith("opencode/big-pickle\nanthropic/claude-opus-4-8\n");
    const result = await listModelsForVendor("opencode");
    expect(result.source).toBe("native");
    expect(result.nativeUnavailableReason).toBeUndefined();
    expect(result.models.map((m) => m.id)).toEqual([
      "opencode/big-pickle",
      "anthropic/claude-opus-4-8",
    ]);
  });

  it("falls back to bundled with the child's stderr in the reason on non-zero exit", async () => {
    execMock.mockRejectedValue(
      Object.assign(new Error("Command failed"), {
        code: 1,
        stderr: "error: unknown option '--json'",
      }),
    );
    const result = await listModelsForVendor("opencode");
    expect(result.source).toBe("bundled");
    expect(result.models).toEqual(VENDOR_MODEL_STRATEGIES.opencode.bundled);
    expect(result.nativeUnavailableReason).toContain("opencode models");
    expect(result.nativeUnavailableReason).toContain("unknown option '--json'");
  });

  it("reports a missing binary distinctly (ENOENT)", async () => {
    execMock.mockRejectedValue(
      Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }),
    );
    const result = await listModelsForVendor("opencode");
    expect(result.source).toBe("bundled");
    expect(result.nativeUnavailableReason).toMatch(/not installed|not on PATH/);
  });

  it("treats unrecognized output as failure, not an empty native list", async () => {
    resolveWith("{ totally: 'unexpected' }");
    const result = await listModelsForVendor("opencode");
    expect(result.source).toBe("bundled");
    expect(result.nativeUnavailableReason).toContain(
      "did not contain any model identifiers",
    );
  });

  it("caches the result per vendor within the TTL", async () => {
    resolveWith("anthropic/claude-sonnet-4-6\n");
    await listModelsForVendor("opencode");
    await listModelsForVendor("opencode");
    expect(execMock).toHaveBeenCalledTimes(1);
    clearModelListCache();
    await listModelsForVendor("opencode");
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it("caches successes for 60s and expires them after", async () => {
    vi.useFakeTimers();
    try {
      resolveWith("anthropic/claude-sonnet-4-6\n");
      await listModelsForVendor("opencode");
      vi.advanceTimersByTime(59_000);
      await listModelsForVendor("opencode");
      expect(execMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      await listModelsForVendor("opencode");
      expect(execMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches failures for only 10s so a just-installed CLI shows up quickly", async () => {
    vi.useFakeTimers();
    try {
      execMock.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
      const failed = await listModelsForVendor("opencode");
      expect(failed.source).toBe("bundled");
      vi.advanceTimersByTime(9_000);
      await listModelsForVendor("opencode");
      expect(execMock).toHaveBeenCalledTimes(1);

      // CLI gets "installed" — past the failure TTL the probe re-runs.
      vi.advanceTimersByTime(2_000);
      resolveWith("opencode/big-pickle\n");
      const recovered = await listModelsForVendor("opencode");
      expect(execMock).toHaveBeenCalledTimes(2);
      expect(recovered.source).toBe("native");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("listModelsForVendor — claude (declared unsupported)", () => {
  it("never spawns a probe and serves the bundled aliases with a curated reason", async () => {
    const result = await listModelsForVendor("claude");
    expect(execMock).not.toHaveBeenCalled();
    expect(result.source).toBe("bundled");
    expect(result.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(result.nativeUnavailableReason).toContain(
      "does not provide a model-listing command",
    );
  });
});

describe("strategy probe matrix", () => {
  // Every strategy that declares a native probe gets the same three-case
  // treatment. A future vendor added with a probe is enrolled automatically.
  const probed = SUPPORTED_VENDORS.filter(
    (v) => !("unavailableReason" in VENDOR_MODEL_STRATEGIES[v].native),
  );

  it.each(probed)(
    "%s: success → native, garbage → bundled, error → bundled",
    async (vendor) => {
      // Build the success payload from the strategy's own bundled-shaped ids
      // so the case stays valid for vendors with different id formats.
      const sampleIds = VENDOR_MODEL_STRATEGIES[vendor].bundled.map(
        (m) => m.id,
      );
      resolveWith(`${sampleIds.join("\n")}\n`);
      const success = await listModelsForVendor(vendor);
      expect(success.source).toBe("native");
      expect(success.models.map((m) => m.id)).toEqual(sampleIds);

      clearModelListCache();
      resolveWith("complete garbage that parses to nothing");
      const garbage = await listModelsForVendor(vendor);
      expect(garbage.source).toBe("bundled");
      expect(garbage.nativeUnavailableReason).toBeTruthy();

      clearModelListCache();
      execMock.mockRejectedValue(
        Object.assign(new Error("boom"), { code: 1, stderr: "boom" }),
      );
      const errored = await listModelsForVendor(vendor);
      expect(errored.source).toBe("bundled");
      expect(errored.nativeUnavailableReason).toBeTruthy();
    },
  );
});

describe("detectActiveVendor", () => {
  it("returns the first vendor whose --version succeeds, in table order", async () => {
    execMock.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    execMock.mockResolvedValueOnce({ stdout: "1.17.0\n", stderr: "" });
    const vendor = await detectActiveVendor();
    expect(vendor).toBe("opencode");
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      "claude",
      ["--version"],
      expect.anything(),
    );
  });

  it("returns null when no vendor responds", async () => {
    execMock.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    expect(await detectActiveVendor()).toBeNull();
  });
});

describe("vendor registry", () => {
  it("derives SUPPORTED_VENDORS and isModelVendor from the strategy table", () => {
    expect(SUPPORTED_VENDORS).toEqual(["claude", "opencode"]);
    expect(isModelVendor("claude")).toBe(true);
    expect(isModelVendor("opencode")).toBe(true);
    expect(isModelVendor("codex")).toBe(false);
  });

  it("rejects prototype-chain keys (own-keys guard, not `in`)", () => {
    expect(isModelVendor("constructor")).toBe(false);
    expect(isModelVendor("__proto__")).toBe(false);
    expect(isModelVendor("toString")).toBe(false);
  });
});
