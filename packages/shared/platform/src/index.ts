/**
 * Cross-platform utilities for Open Code Review.
 *
 * Thin wrappers around Node.js built-in APIs that handle Windows-specific
 * requirements (file:// URLs for ESM imports, shell for .cmd shims).
 * These work identically on all platforms — no conditional branching needed
 * at call sites.
 */

import { pathToFileURL } from "node:url";
import {
  execFile,
  execFileSync,
  spawn,
  type ExecFileOptions,
  type SpawnOptions,
  type ExecFileSyncOptions,
  type ChildProcess,
} from "node:child_process";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);

const isWindows = process.platform === "win32";

/**
 * Dynamically import a module from an absolute file path.
 *
 * Converts the path to a `file://` URL before importing, which is required
 * on Windows and harmless on POSIX. This is the canonical approach recommended
 * by the Node.js ESM documentation.
 */
export async function importModule<T = Record<string, unknown>>(
  absolutePath: string,
): Promise<T> {
  return import(pathToFileURL(absolutePath).href) as Promise<T>;
}

/**
 * Execute a binary synchronously with cross-platform .cmd/.bat support.
 *
 * On Windows, npm-installed binaries are `.cmd` shims that require a shell
 * to execute. On POSIX, `shell: false` is used to avoid unnecessary shell
 * injection surface.
 */
export function execBinary(
  binary: string,
  args: string[],
  opts: ExecFileSyncOptions & { encoding: BufferEncoding },
): string {
  return execFileSync(binary, args, {
    ...opts,
    shell: isWindows,
  }) as string;
}

/**
 * Execute a binary asynchronously with cross-platform .cmd/.bat support.
 *
 * Async counterpart of `execBinary`. On Windows, npm-installed binaries are
 * `.cmd` shims that require a shell to execute.
 */
export async function execBinaryAsync(
  binary: string,
  args: string[],
  opts: ExecFileOptions & { encoding: BufferEncoding },
): Promise<{ stdout: string; stderr: string }> {
  return execFilePromise(binary, args, {
    ...opts,
    shell: isWindows,
  }) as Promise<{ stdout: string; stderr: string }>;
}

/**
 * Spawn a child process with cross-platform .cmd/.bat support.
 *
 * On Windows, sets `shell: true` for .cmd shim resolution and
 * `windowsHide: true` to prevent a console window from flashing
 * (important when combined with `detached: true`).
 */
export function spawnBinary(
  binary: string,
  args: string[],
  opts?: SpawnOptions,
): ChildProcess {
  return spawn(binary, args, {
    ...opts,
    ...(isWindows && { shell: true, windowsHide: true }),
  });
}

// ── Reviewer icons ──

/**
 * Canonical icon mapping for built-in reviewers. The string values are
 * resolved to lucide-react glyphs by the dashboard's icon registry; the CLI
 * writes them verbatim into `reviewers-meta.json`. This is the single source
 * of truth shared by both packages so the two never drift.
 */
export const BUILTIN_ICON_MAP: Record<string, string> = {
  architect: "blocks",
  fullstack: "layers",
  reliability: "activity",
  "staff-engineer": "compass",
  principal: "crown",
  frontend: "layout",
  backend: "server",
  infrastructure: "cloud",
  performance: "gauge",
  accessibility: "accessibility",
  data: "database",
  devops: "rocket",
  dx: "terminal",
  mobile: "smartphone",
  security: "shield-alert",
  quality: "sparkles",
  testing: "test-tubes",
  ai: "bot",
  "docs-writer": "file-text",
};

/**
 * Resolve the default icon for a reviewer given its id and tier.
 *
 * Built-in reviewers get their mapped glyph; everything else falls back to a
 * tier-appropriate generic (`brain` for personas, `user` otherwise). This is
 * the authority every write/read boundary uses to guarantee a reviewer always
 * has a non-empty icon, so the dashboard never renders an `undefined` icon.
 *
 * `tier` is accepted as a plain string to avoid coupling this package to the
 * `ReviewerTier` union, which is declared separately in the CLI and dashboard.
 */
export function defaultIconFor(id: string, tier: string): string {
  return BUILTIN_ICON_MAP[id] ?? (tier === "persona" ? "brain" : "user");
}
