/**
 * Process-liveness primitive shared by the dashboard's supervision paths — the
 * startup orphan-kill block and the periodic liveness sweep.
 *
 * A terminal "orphaned" verdict must rest on positive evidence that a process
 * is gone, never on heartbeat age. `process.kill(pid, 0)` is that evidence: it
 * sends no signal, it only asks the OS whether the pid exists and is
 * signalable. OCR is local-first / single-machine, so this is authoritative.
 */

/** Predicate: true if `pid` names a live process we must NOT declare dead. */
export type IsAlive = (pid: number) => boolean;

/**
 * Beyond this age a recorded pid can no longer be trusted: the OS may have
 * recycled it onto an unrelated process, so a probe could falsely report
 * "alive" (or, for the kill path, signal a stranger). Rows older than this are
 * never orphaned by the liveness sweep — they are reclaimed only at coarser,
 * safer boundaries (dashboard-restart cancellation, the session-level sweep).
 */
export const PID_REUSE_GUARD_MS = 24 * 60 * 60 * 1000;

/** Canonical liveness probe: alive iff `process.kill(pid, 0)` succeeds. */
export function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking only — no signal is sent. Throws
    // ESRCH when the pid is gone (and EPERM when it exists but isn't ours,
    // which on a single-user local box we also treat as "not reclaimable").
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a SQLite `datetime('now')` timestamp (`YYYY-MM-DD HH:MM:SS`, UTC, no
 * zone marker) as a real UTC instant. Plain `new Date(...)` on that format
 * parses as local time.
 */
export function sqliteUtcMs(ts: string): number {
  return new Date(ts.replace(" ", "T") + "Z").getTime();
}
