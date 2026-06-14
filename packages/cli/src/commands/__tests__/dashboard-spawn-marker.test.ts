import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDashboardSpawnMarker } from "../state.js";
import {
  makeTempWorkspace,
  removeTempWorkspace,
} from "@open-code-review/persistence/test-support";

/**
 * Round-1 S25: per-execution dashboard spawn markers.
 *
 * The dashboard formerly wrote a single `dashboard-active-spawn.json`,
 * last-write-wins — a second concurrent review clobbered the first's
 * marker and silently mislinked it. Markers now live one-per-execution
 * under `data/dashboard-active-spawn/{uid}.json`, and the CLI's fallback
 * resolver consumes the UNIQUE live marker, declining to guess when more
 * than one spawn is live.
 *
 * Classical (Detroit) tests: real temp filesystem, real marker files,
 * real PID liveness via `process.kill(pid, 0)`.
 */

let tmpDir: string;
let ocrDir: string;

/** A PID guaranteed dead for the duration of a test: spawn, kill, await. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to spawn child for dead pid");
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGKILL");
  });
  // Poll until the OS has actually reaped it.
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`pid ${pid} never died`);
}

function markerDir(): string {
  return join(ocrDir, "data", "dashboard-active-spawn");
}

function writeMarker(uid: string, pid: number): void {
  mkdirSync(markerDir(), { recursive: true });
  writeFileSync(
    join(markerDir(), `${uid}.json`),
    JSON.stringify({ execution_uid: uid, pid, started_at: "2026-06-14T00:00:00Z" }),
  );
}

function writeLegacyMarker(uid: string, pid: number): void {
  mkdirSync(join(ocrDir, "data"), { recursive: true });
  writeFileSync(
    join(ocrDir, "data", "dashboard-active-spawn.json"),
    JSON.stringify({ execution_uid: uid, pid, started_at: "2026-06-14T00:00:00Z" }),
  );
}

beforeEach(() => {
  tmpDir = makeTempWorkspace("ocr-spawn-marker-");
  ocrDir = join(tmpDir, ".ocr");
  mkdirSync(ocrDir, { recursive: true });
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
});

describe("readDashboardSpawnMarker (S25)", () => {
  it("returns the single live marker", () => {
    writeMarker("uid-a", process.pid);
    const marker = readDashboardSpawnMarker(ocrDir);
    expect(marker?.execution_uid).toBe("uid-a");
  });

  it("declines (null) when two live markers are present — ambiguous", () => {
    writeMarker("uid-a", process.pid);
    writeMarker("uid-b", process.pid);
    expect(readDashboardSpawnMarker(ocrDir)).toBeNull();
  });

  it("ignores a dead-pid marker and consumes the lone live one", async () => {
    writeMarker("uid-dead", await deadPid());
    writeMarker("uid-live", process.pid);
    const marker = readDashboardSpawnMarker(ocrDir);
    // Only one live marker remains, so resolution is unambiguous.
    expect(marker?.execution_uid).toBe("uid-live");
  });

  it("returns null when the directory has only dead markers and no legacy file", async () => {
    writeMarker("uid-dead", await deadPid());
    expect(readDashboardSpawnMarker(ocrDir)).toBeNull();
  });

  it("falls back to the legacy single-file marker when the dir is empty", () => {
    writeLegacyMarker("uid-legacy", process.pid);
    const marker = readDashboardSpawnMarker(ocrDir);
    expect(marker?.execution_uid).toBe("uid-legacy");
  });

  it("prefers per-execution markers over the legacy file", () => {
    writeMarker("uid-new", process.pid);
    writeLegacyMarker("uid-legacy", process.pid);
    const marker = readDashboardSpawnMarker(ocrDir);
    expect(marker?.execution_uid).toBe("uid-new");
  });

  it("returns null when no markers exist at all", () => {
    expect(readDashboardSpawnMarker(ocrDir)).toBeNull();
  });
});
