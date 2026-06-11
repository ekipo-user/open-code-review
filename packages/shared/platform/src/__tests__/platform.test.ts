import { resolve } from "node:path";
import { writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, afterAll } from "vitest";
import {
  importModule,
  execBinary,
  execBinaryAsync,
  defaultIconFor,
  BUILTIN_ICON_MAP,
} from "../index.js";

/**
 * Behavioral tests for platform utilities.
 *
 * These test observable behavior — not implementation details.
 * Cross-platform coverage (Windows vs POSIX) is verified by the
 * GitHub Actions OS matrix, not by mocking process.platform.
 */

// Create a temp module for importModule tests
const tmpDir = realpathSync(mkdtempSync(resolve(tmpdir(), "ocr-platform-test-")));
const tmpModule = resolve(tmpDir, "test-module.mjs");
writeFileSync(tmpModule, "export const greeting = 'hello from module';");

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("importModule", () => {
  it("dynamically imports a module from an absolute file path", async () => {
    const mod = await importModule<{ greeting: string }>(tmpModule);
    expect(mod.greeting).toBe("hello from module");
  });

  it("resolves named exports from the imported module", async () => {
    const multiExportPath = resolve(tmpDir, "multi.mjs");
    writeFileSync(
      multiExportPath,
      "export const a = 1; export const b = 2;",
    );

    const mod = await importModule<{ a: number; b: number }>(multiExportPath);
    expect(mod.a).toBe(1);
    expect(mod.b).toBe(2);
  });

  it("rejects with an error for a non-existent path", async () => {
    await expect(
      importModule("/tmp/does-not-exist-abcdef.mjs"),
    ).rejects.toThrow();
  });
});

describe("execBinary", () => {
  it("executes a binary and returns its stdout", () => {
    const output = execBinary("git", ["--version"], { encoding: "utf-8" });
    expect(output).toMatch(/git version \d+\.\d+/);
  });

  it("passes arguments correctly to the binary", () => {
    const output = execBinary("node", ["-e", "console.log('hello')"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("hello");
  });

  it("throws when the binary does not exist", () => {
    expect(() =>
      execBinary("nonexistent-binary-xyz", ["--version"], {
        encoding: "utf-8",
        timeout: 2000,
      }),
    ).toThrow();
  });
});

describe("execBinaryAsync", () => {
  it("executes a binary and resolves with its stdout", async () => {
    const { stdout } = await execBinaryAsync("node", ["-e", "console.log('async')"], {
      encoding: "utf-8",
    });
    expect(stdout.trim()).toBe("async");
  });

  it("rejects when the binary does not exist", async () => {
    await expect(
      execBinaryAsync("nonexistent-binary-xyz", ["--version"], {
        encoding: "utf-8",
        timeout: 2000,
      }),
    ).rejects.toThrow();
  });
});

describe("spawnBinary", () => {
  // spawnBinary returns a ChildProcess — we verify it spawns
  // correctly by reading stdout from a known command.
  it("spawns a process that produces output", async () => {
    const { spawnBinary } = await import("../index.js");

    const proc = spawnBinary("node", ["-e", "console.log('spawned')"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = await new Promise<string>((resolve, reject) => {
      let data = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      proc.on("close", () => resolve(data.trim()));
      proc.on("error", reject);
    });

    expect(output).toBe("spawned");
  });

  it("passes cwd option to the spawned process", async () => {
    const { spawnBinary } = await import("../index.js");

    const proc = spawnBinary("node", ["-e", "console.log(process.cwd())"], {
      cwd: tmpDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = await new Promise<string>((resolve, reject) => {
      let data = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      proc.on("close", () => resolve(data.trim()));
      proc.on("error", reject);
    });

    expect(output).toBe(tmpDir);
  });
});

describe("defaultIconFor", () => {
  it("returns the mapped glyph for a built-in reviewer id", () => {
    expect(defaultIconFor("architect", "holistic")).toBe("blocks");
    expect(defaultIconFor("security", "specialist")).toBe("shield-alert");
    expect(defaultIconFor("docs-writer", "specialist")).toBe("file-text");
  });

  it("falls back to 'brain' for an unknown persona", () => {
    expect(defaultIconFor("unknown-persona", "persona")).toBe("brain");
  });

  it("falls back to 'user' for an unknown non-persona reviewer", () => {
    expect(defaultIconFor("my-custom-reviewer", "custom")).toBe("user");
    expect(defaultIconFor("whatever", "specialist")).toBe("user");
  });

  it("never returns an empty string", () => {
    for (const id of ["", "x", "architect", ...Object.keys(BUILTIN_ICON_MAP)]) {
      for (const tier of ["holistic", "specialist", "persona", "custom"]) {
        expect(defaultIconFor(id, tier).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("process-tree reaping", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("isProcessAlive reflects a real process's liveness", async () => {
    const { isProcessAlive, spawnBinary } = await import("../index.js");
    const proc = spawnBinary("sleep", ["30"], { stdio: "ignore" });
    await sleep(100);
    expect(isProcessAlive(proc.pid!)).toBe(true);
    process.kill(proc.pid!, "SIGKILL");
    await sleep(200);
    expect(isProcessAlive(proc.pid!)).toBe(false);
  });

  it("descendantPids finds a child and reapTree kills the whole tree", async () => {
    const { descendantPids, reapTree, isProcessAlive, spawnBinary } = await import("../index.js");
    // A node parent that spawns a `sleep` grandchild and stays alive.
    const parent = spawnBinary(
      "node",
      ["-e", "require('child_process').spawn('sleep',['30']); setInterval(()=>{},1e9)"],
      { stdio: "ignore", detached: true },
    );
    await sleep(400);
    const kids = descendantPids(parent.pid!);
    expect(kids.length).toBeGreaterThan(0); // the spawned `sleep` is a descendant

    const result = reapTree(parent.pid!, 200);
    // The diagnostic reports the SIGTERM phase: the root + its descendants were
    // signalled, and `ps` was available to enumerate them (round-1 S13).
    expect(result.signaled).toBeGreaterThanOrEqual(kids.length + 1);
    expect(result.psAvailable).toBe(true);

    await sleep(700);
    expect(isProcessAlive(parent.pid!)).toBe(false);
    for (const pid of kids) expect(isProcessAlive(pid)).toBe(false);
  });
});
