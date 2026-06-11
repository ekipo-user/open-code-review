/**
 * Model discovery helpers shared across the CLI surface AND the dashboard.
 *
 * This module is the single source of truth for vendor model enumeration:
 * `ocr models list` and the dashboard's `GET /api/team/models` both resolve
 * through `listModelsForVendor`, and every per-vendor behavior lives in
 * `VENDOR_MODEL_STRATEGIES`. Adding a vendor (Codex, Gemini CLI, …) is one
 * table entry — supported-vendor validation, detection order, and probe
 * mechanics all derive from the table.
 *
 * Identifiers are vendor-native — OCR does not coin its own logical names.
 * Each strategy either declares a native enumeration probe (argv + parser)
 * or documents that the vendor has no model-listing command. When native
 * enumeration is unavailable for any reason, we fall back to the strategy's
 * bundled list and say WHY via `nativeUnavailableReason` — silent fallback
 * is how issue #39 went unnoticed. The user can always type any string the
 * vendor CLI accepts; listed models are convenience, never a gate.
 */

import { execBinaryAsync } from "@open-code-review/platform";

export type ModelDescriptor = {
  id: string;
  displayName?: string;
  provider?: string;
  tags?: string[];
};

type NativeProbe = {
  /** Arguments passed to the vendor binary to enumerate models. */
  args: string[];
  /**
   * Parses the probe's stdout into descriptors. Returns `null` when the
   * output is unrecognized or yields zero models — zero is a failure, not
   * an empty success, so a drifted output format falls back loudly.
   */
  parse: (stdout: string) => ModelDescriptor[] | null;
};

type VendorModelStrategy = {
  displayName: string;
  /**
   * Either a native enumeration probe, or a curated explanation of why the
   * vendor cannot enumerate models. We deliberately do NOT probe commands
   * that are proven not to exist (the previous speculative
   * `claude models --json` probe failed on every call for the product's
   * whole life and masked the failure) — when a vendor ships a real
   * enumeration command, its strategy gains a probe here.
   */
  native: NativeProbe | { unavailableReason: string };
  /** Known-good fallback list, served only when native enumeration fails. */
  bundled: ModelDescriptor[];
};

/**
 * Parses `opencode models` output: one `provider/model` id per line
 * (verified against OpenCode 1.17.0). Tolerates CRLF and blank lines, and
 * skips any line that is not a bare provider-prefixed id so incidental
 * noise (warnings, future banners) cannot corrupt the list.
 */
export function parseOpenCodeModelList(
  stdout: string,
): ModelDescriptor[] | null {
  const models: ModelDescriptor[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\S+\/\S+$/.test(line)) continue;
    const provider = line.slice(0, line.indexOf("/"));
    models.push({ id: line, provider });
  }
  return models.length > 0 ? models : null;
}

export const VENDOR_MODEL_STRATEGIES = {
  claude: {
    displayName: "Claude Code",
    native: {
      // Verified against Claude Code 2.1.x: the CLI has no model-listing
      // subcommand (`claude models --json` → "unknown option"). Revisit if
      // a future release adds one.
      unavailableReason:
        "Claude Code does not provide a model-listing command; " +
        "showing its documented model aliases instead",
    },
    // Vendor-documented aliases that always track the latest generation —
    // dated ids here would go stale by construction (the exact bug class of
    // issue #39). Pinned dated ids remain available via free-text entry.
    bundled: [
      { id: "opus", displayName: "Claude Opus (latest)" },
      { id: "sonnet", displayName: "Claude Sonnet (latest)" },
      { id: "haiku", displayName: "Claude Haiku (latest)" },
    ],
  },
  opencode: {
    displayName: "OpenCode",
    native: {
      // Plain `opencode models` — newline-delimited ids. (`--json` is not a
      // real flag, and `--verbose` interleaves JSON metadata blocks that
      // defeat line parsing.)
      args: ["models"],
      parse: parseOpenCodeModelList,
    },
    bundled: [
      { id: "anthropic/claude-opus-4-8", provider: "anthropic" },
      { id: "anthropic/claude-sonnet-4-6", provider: "anthropic" },
      { id: "anthropic/claude-haiku-4-5", provider: "anthropic" },
    ],
  },
} satisfies Record<string, VendorModelStrategy>;

/** Derived from the strategy table — the table IS the vendor registry. */
export type ModelVendor = keyof typeof VENDOR_MODEL_STRATEGIES;

/** Vendors with a registered model-listing strategy, in detection order. */
export const SUPPORTED_VENDORS = Object.keys(
  VENDOR_MODEL_STRATEGIES,
) as ModelVendor[];

export function isModelVendor(value: string): value is ModelVendor {
  return value in VENDOR_MODEL_STRATEGIES;
}

/**
 * Detects which supported AI CLI is on PATH, in `SUPPORTED_VENDORS` order.
 * Returns the first one whose `<binary> --version` exits cleanly, or `null`
 * if none is available. Note this is PATH-order detection only — the
 * dashboard's `AiCliService` separately honors the `dashboard.ai_cli`
 * config preference for choosing its active adapter.
 */
export async function detectActiveVendor(): Promise<ModelVendor | null> {
  for (const vendor of SUPPORTED_VENDORS) {
    try {
      await execBinaryAsync(vendor, ["--version"], {
        encoding: "utf-8",
        timeout: 3000,
      });
      return vendor;
    } catch {
      // try next
    }
  }
  return null;
}

export type ModelListResult = {
  vendor: ModelVendor;
  source: "native" | "bundled";
  models: ModelDescriptor[];
  /** Why the bundled list is being served. Present iff source is "bundled". */
  nativeUnavailableReason?: string;
};

/**
 * Turns a failed probe into a human-readable reason, preserving the child's
 * stderr — discarding it is what made the original `--json` regression
 * undiagnosable from OCR's own output.
 */
function describeProbeFailure(
  vendor: ModelVendor,
  args: string[],
  err: unknown,
): string {
  const command = `${vendor} ${args.join(" ")}`;
  const e = err as {
    code?: number | string;
    killed?: boolean;
    stderr?: string;
  };
  if (e.code === "ENOENT") {
    return `\`${vendor}\` is not installed or not on PATH`;
  }
  if (e.killed) {
    return `\`${command}\` timed out`;
  }
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  const detail = stderr ? `: ${stderr.split(/\r?\n/)[0]?.slice(0, 200)}` : "";
  const exit = typeof e.code === "number" ? ` with exit code ${e.code}` : "";
  return `\`${command}\` failed${exit}${detail}`;
}

async function tryNativeEnumeration(
  vendor: ModelVendor,
  probe: NativeProbe,
): Promise<
  { models: ModelDescriptor[] } | { models: null; reason: string }
> {
  let stdout: string;
  try {
    const result = await execBinaryAsync(vendor, probe.args, {
      encoding: "utf-8",
      timeout: 5000,
    });
    stdout = result.stdout;
  } catch (err) {
    return { models: null, reason: describeProbeFailure(vendor, probe.args, err) };
  }
  const models = probe.parse(stdout);
  if (!models) {
    return {
      models: null,
      reason: `\`${vendor} ${probe.args.join(" ")}\` output did not contain any model identifiers`,
    };
  }
  return { models };
}

// The dashboard server calls `listModelsForVendor` on a request path; a
// short TTL cache bounds child-process spawns for long-lived consumers.
// One-shot CLI invocations are unaffected (fresh process each run).
const CACHE_TTL_MS = 60_000;
const cache = new Map<ModelVendor, { result: ModelListResult; expiresAt: number }>();

/** Test seam: drop cached enumeration results. */
export function clearModelListCache(): void {
  cache.clear();
}

/**
 * Returns the model list for the given vendor, preferring native CLI
 * enumeration and falling back to the strategy's bundled known-good list —
 * always saying why when it does. Used by `ocr models list` and the
 * dashboard's `GET /api/team/models`.
 */
export async function listModelsForVendor(
  vendor: ModelVendor,
): Promise<ModelListResult> {
  const cached = cache.get(vendor);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const strategy = VENDOR_MODEL_STRATEGIES[vendor];
  if (!strategy) {
    // Unreachable for ModelVendor inputs; guards JS callers.
    throw new Error(`Unknown vendor: ${vendor}`);
  }

  let result: ModelListResult;
  if ("unavailableReason" in strategy.native) {
    result = {
      vendor,
      source: "bundled",
      models: strategy.bundled,
      nativeUnavailableReason: strategy.native.unavailableReason,
    };
  } else {
    const native = await tryNativeEnumeration(vendor, strategy.native);
    result = native.models
      ? { vendor, source: "native", models: native.models }
      : {
          vendor,
          source: "bundled",
          models: strategy.bundled,
          nativeUnavailableReason: native.reason,
        };
  }

  cache.set(vendor, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
