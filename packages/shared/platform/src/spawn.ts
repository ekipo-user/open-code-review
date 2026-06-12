/**
 * Process-spawn wrappers — the ONLY sanctioned way OCR production code
 * starts child processes (a repo-invariant test enforces this).
 *
 * On Windows, npm-installed binaries are `.cmd` shims that cannot be
 * spawned directly. These wrappers handle that requirement so call sites
 * work identically on all platforms with no conditional branching.
 */

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
