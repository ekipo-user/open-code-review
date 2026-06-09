/**
 * Runtime preconditions that MUST run before the SQLite engine (`node:sqlite`)
 * is touched. The CLI entry imports this FIRST, before any command module.
 *
 * 1. **Node >= 22.5 guard** — `node:sqlite` landed in Node 22.5.0. A too-old
 *    runtime gets a clear, actionable message instead of an opaque
 *    `Cannot find module 'node:sqlite'` crash on first DB access.
 * 2. **Suppress the experimental warning** — `node:sqlite` emits a one-line
 *    `ExperimentalWarning` to stderr on first load. We swallow only that one.
 *
 * The decision logic lives (pure + unit-tested) in `runtime-checks.ts`; this
 * module applies it as side effects on import.
 */

import {
  isSupportedNode,
  isSuppressibleSqliteWarning,
  nodeVersionGuardMessage,
} from "./runtime-checks.js";

if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(nodeVersionGuardMessage(process.versions.node));
  process.exit(1);
}

const originalEmitWarning = process.emitWarning.bind(process);
// @ts-expect-error — replacing the overloaded signature with a pass-through.
process.emitWarning = (warning, ...args) => {
  if (isSuppressibleSqliteWarning(warning)) return;
  // @ts-expect-error — forward the original (overloaded) arguments unchanged.
  return originalEmitWarning(warning, ...args);
};
