/**
 * `GET /api/team/models` end-to-end tests — the dashboard half of the
 * issue-#39 regression net (the CLI half lives in cli-e2e's
 * models-list.test.ts; both resolve through the same strategy table in
 * `@open-code-review/config/models`, which is the point).
 *
 * Each test forks a real dashboard server with stub vendor binaries
 * prepended to PATH, so enumeration behavior is deterministic regardless
 * of what is installed on the machine. One server per stub configuration —
 * the lib caches results per vendor within a process.
 */

import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import { startTestServer, type ServerInstance } from "./helpers/server-harness.js";
import { createVendorStubs, type VendorStubs } from "./helpers/vendor-stubs.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups) await fn();
});

function trackedStubs(stubs: VendorStubs): VendorStubs {
  cleanups.push(stubs.cleanup);
  return stubs;
}

function trackedServer(server: ServerInstance): ServerInstance {
  cleanups.push(server.cleanup);
  return server;
}

/** Unique tmp path for a tripwire marker, cleaned up after the suite. */
function tripwireMarkerPath(): string {
  const markerPath = resolve(tmpdir(), `ocr-claude-probed-${randomUUID()}.txt`);
  cleanups.push(() => {
    rmSync(markerPath, { force: true });
  });
  return markerPath;
}

type Envelope = {
  vendor: string | null;
  source: "native" | "bundled" | null;
  models: Array<{ id: string; provider?: string }>;
  nativeUnavailableReason?: string;
};

async function getModels(
  server: ServerInstance,
  query: string,
): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${server.baseUrl}/api/team/models${query}`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  return { status: res.status, body: (await res.json()) as Envelope };
}

describe("GET /api/team/models", () => {
  it("opencode native success: returns vendor ids with source 'native'", async () => {
    const stubs = trackedStubs(
      createVendorStubs({
        opencode: {
          kind: "native",
          ids: ["anthropic/claude-sonnet-4-6", "opencode/big-pickle"],
        },
      }),
    );
    const server = trackedServer(await startTestServer({ env: stubs.env }));

    const { status, body } = await getModels(server, "?vendor=opencode");
    expect(status).toBe(200);
    expect(body.vendor).toBe("opencode");
    expect(body.source).toBe("native");
    expect(body.nativeUnavailableReason).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "opencode/big-pickle",
    ]);
  });

  it("opencode malformed output: falls back to bundled with a reason", async () => {
    const stubs = trackedStubs(
      createVendorStubs({ opencode: { kind: "garbage" } }),
    );
    const server = trackedServer(await startTestServer({ env: stubs.env }));

    const { status, body } = await getModels(server, "?vendor=opencode");
    expect(status).toBe(200);
    expect(body.source).toBe("bundled");
    expect(body.nativeUnavailableReason).toMatch(
      /did not contain any model identifiers/,
    );
  });

  it("claude: bundled aliases + curated reason, no probe spawned", async () => {
    const markerPath = tripwireMarkerPath();
    // Tripwire stub: would happily answer `models`, but records the call.
    const stubs = trackedStubs(
      createVendorStubs({ claude: { kind: "tripwire", markerPath } }),
    );
    const server = trackedServer(await startTestServer({ env: stubs.env }));

    const { status, body } = await getModels(server, "?vendor=claude");
    expect(status).toBe(200);
    expect(body.vendor).toBe("claude");
    expect(body.source).toBe("bundled");
    expect(body.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(body.nativeUnavailableReason).toMatch(
      /does not provide a model-listing command/,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it("vendor=auto resolves in strategy-table order (claude first)", async () => {
    const markerPath = tripwireMarkerPath();
    const stubs = trackedStubs(
      createVendorStubs({
        claude: { kind: "tripwire", markerPath },
        opencode: { kind: "native", ids: ["opencode/big-pickle"] },
      }),
    );
    const server = trackedServer(await startTestServer({ env: stubs.env }));

    const { status, body } = await getModels(server, "?vendor=auto");
    expect(status).toBe(200);
    expect(body.vendor).toBe("claude");
    expect(body.source).toBe("bundled");
  });

  it("rejects an unknown vendor with 400", async () => {
    const stubs = trackedStubs(
      createVendorStubs({ opencode: { kind: "native", ids: ["a/b"] } }),
    );
    const server = trackedServer(await startTestServer({ env: stubs.env }));

    const res = await fetch(
      `${server.baseUrl}/api/team/models?vendor=nonexistent`,
      { headers: { Authorization: `Bearer ${server.token}` } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects an array-form vendor query with 400 instead of hanging", async () => {
    const stubs = trackedStubs(
      createVendorStubs({ opencode: { kind: "native", ids: ["a/b"] } }),
    );
    const server = trackedServer(await startTestServer({ env: stubs.env }));

    // Express parses ?vendor=a&vendor=b as an array. Before the fix this
    // threw outside the async handler's try → swallowed unhandled rejection
    // and a request that never answers. AbortSignal.timeout turns a hung
    // response into a deterministic test failure instead of a suite stall.
    const res = await fetch(
      `${server.baseUrl}/api/team/models?vendor=opencode&vendor=claude`,
      {
        headers: { Authorization: `Bearer ${server.token}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns the null envelope when no vendor is installed", async () => {
    const stubs = trackedStubs(
      createVendorStubs({
        claude: { kind: "absent" },
        opencode: { kind: "absent" },
      }),
    );
    const server = trackedServer(await startTestServer({ env: stubs.env }));

    const { status, body } = await getModels(server, "");
    expect(status).toBe(200);
    expect(body).toEqual({ vendor: null, source: null, models: [] });
  });
});
