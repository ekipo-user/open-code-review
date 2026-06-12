/**
 * Process-liveness primitive shared by the dashboard's supervision paths — the
 * startup orphan-kill block and the periodic liveness sweep.
 *
 * A terminal "orphaned" verdict must rest on positive evidence that a process
 * is gone, never on heartbeat age. `process.kill(pid, 0)` is that evidence: it
 * sends no signal, it only asks the OS whether the pid exists and is
 * signalable. OCR is local-first / single-machine, so this is authoritative.
 */

import { killErrorMeansDead } from "@open-code-review/platform";

/** Predicate: true if `pid` names a live process we must NOT declare dead. */
export type IsAlive = (pid: number) => boolean;

/**
 * Beyond this age a recorded pid can no longer be trusted: the OS may have
 * recycled it onto an unrelated process, so a probe could falsely report
 * "alive" (or, for the kill path, signal a stranger). Rows older than this are
 * never orphaned by the liveness sweep — they are reclaimed only at coarser,
 * safer boundaries (dashboard-restart cancellation, the session-level sweep).
 *
 * 24h is comfortable for OCR's local-first use: a dev box rarely cycles through
 * its whole pid space (macOS `pid_max` ~99999, Linux default 32768) within a
 * day, so a pid this row recorded yesterday is almost certainly still that
 * process or genuinely gone — not a stranger. The window is anchored on
 * `started_at` (the row's birthday), NOT `last_heartbeat_at`: the heartbeat is
 * refreshed by the row's own writer, so anchoring on it would create a
 * self-extending window that never expires for an actively-beating row.
 */
export const PID_REUSE_GUARD_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical liveness probe. `process.kill(pid, 0)` sends no signal — it only
 * asks the OS about the pid — and distinguishes the outcomes by `errno`:
 *   - success → the process exists and is signalable: ALIVE.
 *   - ESRCH   → no such process: genuinely DEAD (the only "dead" verdict).
 *   - EPERM   → the process exists but isn't ours to signal: ALIVE (a terminal
 *               orphan/cascade on a live-but-unsignalable process would be a
 *               false death — matters once reviewer agents run in other
 *               process groups / containers).
 *   - anything else → be conservative and treat as ALIVE, so the row stays
 *               in-flight and is reclaimed at a coarser, safer boundary.
 * Only positive evidence of death (ESRCH) yields a "dead" verdict.
 */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Only ESRCH ("no such process") is positive evidence of death — the
    // shared platform classifier owns that decision (one contract for this
    // and the platform's `isProcessAlive`; previously duplicated).
    return !killErrorMeansDead(err);
  }
}

/**
 * Parse a `command_executions` timestamp to a UTC millisecond instant. The
 * column carries TWO shapes, because two writers populate it:
 *   - SQLite `datetime('now')` → `"YYYY-MM-DD HH:MM:SS"` (UTC, space-delimited,
 *     no zone marker) — written by the CLI / column defaults. Plain
 *     `new Date(...)` would misparse this as LOCAL time.
 *   - JS `Date.toISOString()` → `"YYYY-MM-DDTHH:MM:SS.sssZ"` (already zoned) —
 *     written by the dashboard's command-runner. `new Date(...)` parses this
 *     correctly as-is.
 * The space delimiter (only ever present in the SQLite shape) is the
 * discriminator. Handling both is load-bearing: the 24h PID-reuse guard reads
 * this on dashboard-spawned supervisor rows, whose `started_at` is ISO — a
 * naive `+ "Z"` there yields `Invalid Date`/`NaN`, silently disabling the guard.
 */
export function sqliteUtcMs(ts: string): number {
  const sqliteShape = ts.includes(" ");
  return new Date(sqliteShape ? ts.replace(" ", "T") + "Z" : ts).getTime();
}
