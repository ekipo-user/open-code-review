/**
 * `ocr models list` end-to-end tests — the per-vendor-strategy regression
 * net for issue #39.
 *
 * Stub vendor binaries are prepended to PATH (see helpers/vendor-stubs.ts)
 * so every case is deterministic regardless of which real CLIs are
 * installed on the machine. The stubs are argv-strict: the opencode
 * native-success cases fail if the probe ever drifts from plain
 * `opencode models` (e.g. the `--json` regression this suite exists to
 * prevent), because the stub rejects unexpected argv and the result
 * silently degrades to `source: "bundled"` — which these tests assert
 * against exactly.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { spawnCli } from "./helpers/spawn-cli.js";
import { createVendorStubs, type VendorStubs } from "./helpers/vendor-stubs.js";
import {
  createInitializedProject,
  type TempProject,
} from "./helpers/temp-project.js";

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((fn) => fn()));

function tracked<T extends TempProject>(project: T): T {
  cleanups.push(project.cleanup);
  return project;
}

function trackedStubs(stubs: VendorStubs): VendorStubs {
  cleanups.push(stubs.cleanup);
  return stubs;
}

type Envelope = {
  vendor: string | null;
  source: "native" | "bundled" | null;
  models: Array<{ id: string; provider?: string }>;
  nativeUnavailableReason?: string;
};

async function modelsListJson(
  project: TempProject,
  stubs: VendorStubs,
  vendorArgs: string[],
): Promise<Envelope> {
  const result = await spawnCli(
    ["models", "list", ...vendorArgs, "--json"],
    { cwd: project.dir, env: stubs.env },
  );
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as Envelope;
}

describe("ocr models list — opencode strategy", () => {
  it("native success: surfaces the vendor's ids with source 'native'", async () => {
    const project = tracked(createInitializedProject());
    const stubs = trackedStubs(
      createVendorStubs({
        opencode: {
          kind: "native",
          ids: ["anthropic/claude-sonnet-4-6", "opencode/big-pickle"],
        },
      }),
    );

    const envelope = await modelsListJson(project, stubs, [
      "--vendor",
      "opencode",
    ]);
    expect(envelope.vendor).toBe("opencode");
    expect(envelope.source).toBe("native");
    expect(envelope.nativeUnavailableReason).toBeUndefined();
    expect(envelope.models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "opencode/big-pickle",
    ]);
    // Provider derives from the slash prefix of the vendor-native id.
    expect(envelope.models[0]?.provider).toBe("anthropic");
  });

  it("native success: tolerates CRLF output on every platform", async () => {
    const project = tracked(createInitializedProject());
    const stubs = trackedStubs(
      createVendorStubs({
        opencode: {
          kind: "native",
          ids: ["anthropic/claude-opus-4-8", "opencode/big-pickle"],
          lineEnding: "\r\n",
        },
      }),
    );

    const envelope = await modelsListJson(project, stubs, [
      "--vendor",
      "opencode",
    ]);
    expect(envelope.source).toBe("native");
    expect(envelope.models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4-8",
      "opencode/big-pickle",
    ]);
  });

  it("malformed native output: falls back to bundled and says why", async () => {
    const project = tracked(createInitializedProject());
    const stubs = trackedStubs(
      createVendorStubs({ opencode: { kind: "garbage" } }),
    );

    const envelope = await modelsListJson(project, stubs, [
      "--vendor",
      "opencode",
    ]);
    expect(envelope.source).toBe("bundled");
    expect(envelope.nativeUnavailableReason).toMatch(
      /did not contain any model identifiers/,
    );
    // Bundled OpenCode ids keep the provider/ prefix shape.
    expect(envelope.models.length).toBeGreaterThan(0);
    for (const model of envelope.models) {
      expect(model.id).toMatch(/.+\/.+/);
    }
  });

  it("vendor unavailable: falls back to bundled with a reason", async () => {
    const project = tracked(createInitializedProject());
    // The 'absent' stub exits 127 for ALL argv — it shadows any real
    // opencode on the runner, simulating "not installed" deterministically.
    const stubs = trackedStubs(
      createVendorStubs({ opencode: { kind: "absent" } }),
    );

    const envelope = await modelsListJson(project, stubs, [
      "--vendor",
      "opencode",
    ]);
    expect(envelope.source).toBe("bundled");
    expect(envelope.nativeUnavailableReason).toBeTruthy();
  });
});

describe("ocr models list — claude strategy (declared unsupported)", () => {
  it("serves bundled aliases with the curated reason and NEVER probes", async () => {
    const project = tracked(createInitializedProject());
    const markerPath = resolve(project.dir, "claude-was-probed.txt");
    // Tripwire stub: would happily answer `models`, but records the call.
    const stubs = trackedStubs(
      createVendorStubs({ claude: { kind: "tripwire", markerPath } }),
    );

    const envelope = await modelsListJson(project, stubs, [
      "--vendor",
      "claude",
    ]);
    expect(envelope.vendor).toBe("claude");
    expect(envelope.source).toBe("bundled");
    expect(envelope.models.map((m) => m.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(envelope.nativeUnavailableReason).toMatch(
      /does not provide a model-listing command/,
    );
    // The strategy declares enumeration unsupported — no probe process may
    // be spawned. If this fails, someone reintroduced a speculative probe.
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("ocr models list — vendor resolution", () => {
  it("rejects an unknown vendor", async () => {
    const project = tracked(createInitializedProject());
    const result = await spawnCli(
      ["models", "list", "--vendor", "nonexistent-vendor"],
      { cwd: project.dir },
    );
    expect(result.exitCode).not.toBe(0);
  });

  it("emits the null envelope when no vendor CLI is detected", async () => {
    const project = tracked(createInitializedProject());
    // Shadow BOTH vendors with exit-127 stubs so detection deterministically
    // finds nothing, even on machines with the real CLIs installed.
    const stubs = trackedStubs(
      createVendorStubs({
        claude: { kind: "absent" },
        opencode: { kind: "absent" },
      }),
    );

    const envelope = await modelsListJson(project, stubs, []);
    expect(envelope).toEqual({ vendor: null, source: null, models: [] });
  });

  it("autodetects in strategy-table order (claude first)", async () => {
    const project = tracked(createInitializedProject());
    const markerPath = resolve(project.dir, "claude-was-probed.txt");
    const stubs = trackedStubs(
      createVendorStubs({
        claude: { kind: "tripwire", markerPath },
        opencode: { kind: "native", ids: ["opencode/big-pickle"] },
      }),
    );

    const envelope = await modelsListJson(project, stubs, []);
    expect(envelope.vendor).toBe("claude");
    expect(envelope.source).toBe("bundled");
  });
});
