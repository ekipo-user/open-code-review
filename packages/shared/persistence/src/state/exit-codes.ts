/**
 * Canonical exit-code / process-sentinel taxonomy.
 *
 * This is the ONE definition of:
 *   - {@link STATE_EXIT}: the CLI's structured failure taxonomy (0/2/3/4/5/6/7/8),
 *   - {@link StateError}: the error class carrying a STATE_EXIT code,
 *   - the three negative process sentinels stamped on terminated
 *     `command_executions` rows ({@link CANCELLED_EXIT_CODE},
 *     {@link ORPHAN_EXIT_CODE}, {@link CASCADE_CLOSE_EXIT_CODE}).
 *
 * It is a LEAF module: it imports nothing from the state barrel (or anything
 * else in the package), so every other module — `state/index.ts`,
 * `db/agent-sessions.ts`, the db barrel, and (via that barrel) the dashboard —
 * can depend on it without risking an import cycle.
 */

// ── Typed errors / exit-code taxonomy ──

/**
 * Stable exit codes so an orchestrating agent can branch on the failure
 * class without parsing prose. Mirrored in the CLI command layer.
 */
export const STATE_EXIT = {
  OK: 0,
  USAGE: 2,
  AMBIGUOUS: 3,
  NOT_FOUND: 4,
  ILLEGAL_TRANSITION: 5,
  INVARIANT_UNMET: 6,
  SCHEMA_INVALID: 7,
  /** Database was locked past the bounded retry budget (SQLITE_BUSY). */
  BUSY: 8,
} as const;

/** An error carrying a {@link STATE_EXIT} code for deterministic CLI mapping. */
export class StateError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "StateError";
  }
}

// ── Negative process sentinels (command_executions.exit_code) ──
//
// Distinct negative codes stamped on terminated `command_executions` rows so
// triage (and the dashboard's outcome derivation) can tell apart *why* a child
// process row was reclaimed. Real process exit codes are >= 0, so these never
// collide with a vendor CLI's own status. Kept here as the single source of
// truth; `deriveStatus` (agent-sessions.ts) and the dashboard's
// command-outcome derivation both branch on them.

/** A child process the user explicitly cancelled (dashboard "Cancel"). */
export const CANCELLED_EXIT_CODE = -2;

/** A row reclaimed by the heartbeat liveness sweep after its heartbeat went
 *  stale (the process is presumed dead but never reported a real exit). */
export const ORPHAN_EXIT_CODE = -3;

/** A dependent row terminated because its parent workflow was closed
 *  (cascade close). Distinct from -2 (user cancel) and -3 (orphaned by the
 *  liveness sweep) so triage can tell the cause apart. */
export const CASCADE_CLOSE_EXIT_CODE = -4;

/** A row the dashboard watchdog reaped after the execution blew past the hard
 *  deadline with no terminal `result`. Distinct from -2 (cancel), -3 (orphaned),
 *  and -4 (cascade) so triage can tell a deadline timeout apart from an
 *  arbitrary crash via the recorded code. Today the outcome derivation
 *  recognizes it explicitly but still buckets it as 'failed' — a dedicated
 *  "timed out" rendering is the deferred half of round-1 SF9 (a discriminated
 *  TerminationReason). Lives here (not inline in command-runner) so producers
 *  AND the outcome derivation share one definition. */
export const WATCHDOG_DEADLINE_EXIT_CODE = -5;
