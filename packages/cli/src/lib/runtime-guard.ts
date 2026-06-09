/**
 * Runtime preconditions that MUST run before the SQLite engine (`node:sqlite`)
 * is touched. The CLI entry imports this FIRST, before any command module.
 *
 * 1. **Node >= 22.5 guard** — `node:sqlite` landed in Node 22.5.0. A too-old
 *    runtime gets a clear, actionable message instead of an opaque
 *    `Cannot find module 'node:sqlite'` crash on first DB access.
 * 2. **Suppress the experimental warning** — `node:sqlite` emits a one-line
 *    `ExperimentalWarning` to stderr on first load. We swallow only that one,
 *    set up here so the filter is in place before the engine ever loads.
 */

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

const [major = 0, minor = 0] = process.versions.node
  .split(".")
  .map((n) => Number.parseInt(n, 10) || 0);

if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
  process.stderr.write(
    `\nOpen Code Review requires Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} ` +
      `(it uses Node's built-in SQLite, \`node:sqlite\`).\n` +
      `You have Node ${process.versions.node}. Upgrade Node ` +
      `(e.g. \`nvm install 22 && nvm use 22\`) and re-run.\n\n`,
  );
  process.exit(1);
}

// Swallow ONLY node:sqlite's experimental warning; pass everything else through.
const originalEmitWarning = process.emitWarning.bind(process);
// @ts-expect-error — replacing the overloaded signature with a pass-through.
process.emitWarning = (warning, ...args) => {
  const message =
    typeof warning === "string" ? warning : (warning as Error | undefined)?.message;
  if (
    typeof message === "string" &&
    message.includes("SQLite is an experimental feature")
  ) {
    return;
  }
  // @ts-expect-error — forward the original (overloaded) arguments unchanged.
  return originalEmitWarning(warning, ...args);
};
