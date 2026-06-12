/**
 * Process-spawn wrappers — the ONLY sanctioned way OCR production code
 * starts child processes (a repo-invariant test enforces this).
 *
 * Arguments are passed VERBATIM as argv on every platform — never through
 * an interpreting shell. Windows `.cmd`/`.bat` shim resolution (npm-installed
 * binaries like `claude`, `opencode`, `ocr`, `gh`) is handled by cross-spawn,
 * which spawns cmd.exe itself with Microsoft-rules argument quoting plus
 * cmd-metacharacter escaping. The previous implementation passed
 * `shell: true` on Windows, which made every argv string part of one
 * cmd.exe command line — Node does not escape arguments under `shell:
 * true`, so config- or UI-sourced strings (model ids, prompts) became a
 * command-injection surface (issue #43). Plain shell-less spawning of
 * `.cmd` is not an option either: Node rejects it with EINVAL since
 * CVE-2024-27980.
 *
 * Exec semantics (throw-on-failure, the async `{ code, stderr, killed }`
 * rejection shape, timeout kills, the 1 MiB default maxBuffer) are
 * re-created here on top of cross-spawn — it only provides spawn/spawn.sync
 * — and are pinned by contract tests in `__tests__/platform.test.ts`
 * against this real implementation. `describeProbeFailure` in the CLI's
 * model discovery is the canonical consumer of the rejection shape.
 *
 * Residual caveat (defense-in-depth rationale for the parse-boundary
 * model-id validation): argument handling inside a `.cmd` shim itself is
 * only as good as the shim; `%VAR%`-expansion corner cases are the
 * historically weakest spot of cmd escaping, which is why the validation
 * layer excludes `%` from the vendor-id syntax class.
 */

import crossSpawn from "cross-spawn";
import type {
  ExecFileOptions,
  SpawnOptions,
  SpawnSyncOptions,
  ExecFileSyncOptions,
  ChildProcess,
} from "node:child_process";

/** execFile's historical default — re-created because spawn has no maxBuffer. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Execute a binary synchronously. Throws on any failure — missing binary
 * (`code: "ENOENT"` on every platform), non-zero exit (`status`/`code` =
 * the numeric exit code, with `stdout`/`stderr`/`signal` attached), or
 * timeout. Returns the child's stdout decoded with `opts.encoding`.
 * `input`, `stdio`, `timeout`, `cwd`, `env`, and `maxBuffer` pass through
 * to spawnSync.
 */
export function execBinary(
  binary: string,
  args: string[],
  opts: ExecFileSyncOptions & { encoding: BufferEncoding },
): string {
  const result = crossSpawn.sync(binary, args, {
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...opts,
  } as SpawnSyncOptions);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(
      new Error(
        `Command failed: ${binary} ${args.join(" ")}\n${String(result.stderr ?? "")}`,
      ),
      {
        status: result.status,
        code: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        pid: result.pid,
      },
    );
  }
  return result.stdout as unknown as string;
}

/**
 * Execute a binary asynchronously. Resolves `{ stdout, stderr }` on exit 0.
 * Rejects with an Error carrying `{ code: number | "ENOENT", stderr,
 * stdout, killed, signal }`:
 *   - missing binary → `code: "ENOENT"` (cross-spawn's enoent shim makes
 *     this true on Windows too — previously cmd.exe reported exit 1 and
 *     the "not installed" branch of probe-failure reporting could never
 *     fire there);
 *   - non-zero exit → `code` is the numeric exit code, `killed: false`;
 *   - timeout or maxBuffer overflow → the child is killed and
 *     `killed: true` (mirroring promisified execFile, which model
 *     discovery's `describeProbeFailure` keys on).
 */
export async function execBinaryAsync(
  binary: string,
  args: string[],
  opts: ExecFileOptions & { encoding: BufferEncoding },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = crossSpawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
    });

    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const overflow = (): void => {
      // Mirror execFile: kill and report killed=true; the close handler
      // rejects once the process is gone.
      killed = true;
      child.kill();
    };

    child.stdout?.setEncoding(opts.encoding);
    child.stderr?.setEncoding(opts.encoding);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) overflow();
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) overflow();
    });

    const timer = opts.timeout
      ? setTimeout(() => {
          killed = true;
          child.kill();
        }, opts.timeout)
      : undefined;

    // ENOENT (and other spawn-layer failures) arrive here — including on
    // Windows, via cross-spawn's enoent shim. `close` may still follow;
    // the settled flag keeps the first verdict.
    child.on("error", (err) => {
      settle(() =>
        rejectPromise(Object.assign(err, { stdout, stderr, killed })),
      );
    });

    child.on("close", (code, signal) => {
      settle(() => {
        if (code === 0 && !killed) {
          resolvePromise({ stdout, stderr });
          return;
        }
        rejectPromise(
          Object.assign(
            new Error(
              `Command failed: ${binary} ${args.join(" ")}\n${stderr}`,
            ),
            {
              code: code ?? undefined,
              signal,
              stdout,
              stderr,
              killed,
            },
          ),
        );
      });
    });
  });
}

/**
 * Spawn a child process. `.cmd`/`.bat` shims resolve on Windows without a
 * shell; arguments are passed verbatim; `windowsHide` prevents a console
 * window from flashing (important combined with `detached: true`).
 */
export function spawnBinary(
  binary: string,
  args: string[],
  opts?: SpawnOptions,
): ChildProcess {
  return crossSpawn(binary, args, {
    ...opts,
    windowsHide: true,
  });
}
