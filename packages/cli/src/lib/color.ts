import chalk from "chalk";

/**
 * Deterministic terminal-color policy for the CLI.
 *
 * Why this exists: when the CLI is shipped as a single esbuild bundle, relying
 * on chalk's implicit, lazy color auto-detection has proven flaky in published
 * builds (colors appear in dev — where the toolchain, e.g. Nx, sets
 * `FORCE_COLOR` — but not always in the published binary). We instead resolve
 * the color level ONCE, explicitly, at process startup and pin `chalk.level`,
 * so behavior is identical in dev and prod.
 *
 * Policy, in precedence order (mirrors the de-facto standards):
 *   1. `NO_COLOR` (any non-empty value) → disabled            (https://no-color.org)
 *   2. `FORCE_COLOR` → honored (`0`/`1`/`2`/`3`, or `""`/`true`/`false`)
 *   3. otherwise → on iff the target stream is a TTY, with the depth derived
 *      from `COLORTERM` / `TERM` (truecolor → 3, 256 → 2, else → 1)
 *   4. not a TTY (piped / captured) → disabled, so ANSI never pollutes output
 *      that tools or the dashboard parse.
 */
export type ColorLevel = 0 | 1 | 2 | 3;

export function resolveColorLevel(
  stream: Pick<NodeJS.WriteStream, "isTTY"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ColorLevel {
  const noColor = env["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") return 0;

  const force = env["FORCE_COLOR"];
  if (force !== undefined) {
    if (force === "false") return 0;
    if (force === "" || force === "true") return 1;
    const n = Number(force);
    if (Number.isNaN(n)) return 1;
    return Math.max(0, Math.min(3, n)) as ColorLevel;
  }

  if (!stream || !stream.isTTY) return 0;

  const colorterm = env["COLORTERM"] ?? "";
  if (/truecolor|24bit/i.test(colorterm)) return 3;

  const term = env["TERM"] ?? "";
  if (term === "dumb") return 0; // a dumb terminal cannot render ANSI
  if (/256/.test(term)) return 2;
  return 1;
}

/**
 * Pin chalk's color level for the whole process. Call once, as early as
 * possible in the entry point. Idempotent.
 */
export function initColor(
  stream: Pick<NodeJS.WriteStream, "isTTY"> | undefined = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): ColorLevel {
  const level = resolveColorLevel(stream, env);
  chalk.level = level;
  return level;
}
