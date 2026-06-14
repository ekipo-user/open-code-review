/**
 * Pure runtime-precondition logic for the CLI, kept side-effect-free so it can
 * be unit-tested by observable behavior. The side effects (exit on too-old
 * Node, install the warning filter) live in `runtime-guard.ts`, which applies
 * these on import.
 */

/** Node floor for `node:sqlite` (landed in 22.5.0). */
export const NODE_FLOOR = { major: 22, minor: 5 } as const;

/** `true` when `version` (e.g. "22.4.1") satisfies the Node floor for node:sqlite. */
export function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  return (
    major > NODE_FLOOR.major ||
    (major === NODE_FLOOR.major && minor >= NODE_FLOOR.minor)
  );
}

/** The actionable message shown when the runtime is too old. */
export function nodeVersionGuardMessage(version: string): string {
  return (
    `\nOpen Code Review requires Node.js >= ${NODE_FLOOR.major}.${NODE_FLOOR.minor} ` +
    `(it uses Node's built-in SQLite, \`node:sqlite\`).\n` +
    `You have Node ${version}. Upgrade Node ` +
    `(e.g. \`nvm install 22 && nvm use 22\`) and re-run.\n\n`
  );
}

/**
 * `true` only for node:sqlite's experimental warning (so we never swallow
 * others). The substring is a Node-internal string and could change across Node
 * versions; the cli-e2e `doctor` test (asserts stderr has no `/experimental/i`
 * from the real built binary) is the backstop that catches a drift.
 */
export function isSuppressibleSqliteWarning(warning: unknown): boolean {
  const message =
    typeof warning === "string" ? warning : (warning as Error | undefined)?.message;
  return (
    typeof message === "string" &&
    message.includes("SQLite is an experimental feature")
  );
}
