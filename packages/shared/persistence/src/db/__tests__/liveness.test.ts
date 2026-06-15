import { spawn } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { defaultIsAlive, sqliteUtcMs } from "../liveness.js";

describe("sqliteUtcMs", () => {
  it("parses the SQLite datetime('now') shape as UTC, not local", () => {
    // "2026-06-09 15:30:45" is UTC; a naive new Date() would read it as local.
    expect(sqliteUtcMs("2026-06-09 15:30:45")).toBe(Date.UTC(2026, 5, 9, 15, 30, 45));
  });

  it("parses the ISO shape the dashboard command-runner writes (regression: was NaN)", () => {
    // command-runner.ts writes started_at = new Date().toISOString(). The old
    // implementation appended a second 'Z' → Invalid Date → NaN, silently
    // disabling the 24h PID-reuse guard for dashboard-spawned supervisor rows.
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const iso = new Date(twoHoursAgo).toISOString();
    const ms = sqliteUtcMs(iso);
    expect(Number.isNaN(ms)).toBe(false);
    expect(Math.abs(ms - twoHoursAgo)).toBeLessThan(1000);
  });

  it("agrees on both shapes for the same instant", () => {
    const iso = "2026-06-09T15:30:45.000Z";
    const sqlite = "2026-06-09 15:30:45";
    expect(sqliteUtcMs(iso)).toBe(sqliteUtcMs(sqlite));
  });
});

describe("defaultIsAlive", () => {
  it("reports the current process as alive", () => {
    expect(defaultIsAlive(process.pid)).toBe(true);
  });

  it("reports a confirmed-dead pid as not alive (ESRCH)", async () => {
    // Spawn a child, let it exit, then probe its now-dead pid.
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid!;
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    // Give the OS a beat to reap; the pid is gone → ESRCH → dead.
    await new Promise((r) => setTimeout(r, 50));
    expect(defaultIsAlive(pid)).toBe(false);
  });

  it("treats a non-ESRCH failure (EPERM) as alive, never dead", () => {
    // The contract: only ESRCH means dead; EPERM (exists but not ours to
    // signal) means alive. Simulated via a process.kill spy — the previous
    // fixture probed pid 1, which exists on POSIX but not on Windows (where
    // kill(1, 0) throws ESRCH and the test asserted the wrong branch), and
    // was vacuous anyway wherever the runner may signal pid 1. The errno
    // classification itself lives in the shared platform classifier
    // (killErrorMeansDead), pinned by platform unit tests; this pins the
    // CLI wiring.
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    try {
      expect(defaultIsAlive(424242)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
