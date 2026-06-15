/**
 * Per-execution dashboard spawn markers.
 *
 * Extracted from command-runner.ts (round-1 S28) — a cohesive, fs-only slice
 * with no dependency on the orchestrator, so it is a leaf module the runner,
 * the server lifecycle (startup/shutdown), and tests can all import.
 *
 * The dashboard writes one marker per active AI workflow spawn at
 * `.ocr/data/dashboard-active-spawn/{execution_uid}.json`. The CLI's
 * `ocr state begin` reads this directory to know which dashboard
 * `command_executions.uid` to bind its newly-created session to.
 *
 * Per-execution markers (round-1 S25) replace the former single
 * `dashboard-active-spawn.json` file. That file was last-write-wins:
 * with `MAX_CONCURRENT` allowing several simultaneous reviews, a second
 * spawn's marker clobbered the first's, silently mis-linking the first
 * review's `state begin` to the wrong execution. One file per spawn means
 * no live marker is ever destroyed by another. The CLI consumes the
 * UNIQUE live marker and declines to guess when more than one is live —
 * the explicit `--dashboard-uid` flag (which the spawn prompt mandates)
 * remains the primary, unambiguous linkage path.
 */

import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function spawnMarkerDir(ocrDir: string): string {
  return join(ocrDir, 'data', 'dashboard-active-spawn')
}

/**
 * Resolve the marker file for one execution. The uid is a UUID
 * (`generateCommandUid`), but we sanitize defensively so a marker path
 * can never escape the marker directory regardless of the uid's origin.
 */
function spawnMarkerPath(ocrDir: string, executionUid: string): string {
  const safe = executionUid.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(spawnMarkerDir(ocrDir), `${safe}.json`)
}

/** Legacy single-file marker path — read for backward compatibility only. */
function legacySpawnMarkerPath(ocrDir: string): string {
  return join(ocrDir, 'data', 'dashboard-active-spawn.json')
}

/**
 * Write the spawn marker. Called immediately after the AI process is
 * spawned and its PID is captured. Synchronous on purpose — the AI
 * may run `ocr state begin` within milliseconds, and the marker MUST
 * exist when it does.
 */
export function writeSpawnMarker(ocrDir: string, executionUid: string, pid: number): void {
  const dir = spawnMarkerDir(ocrDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const payload = JSON.stringify({
    execution_uid: executionUid,
    pid,
    started_at: new Date().toISOString(),
  })
  writeFileSync(spawnMarkerPath(ocrDir, executionUid), payload, { mode: 0o600 })
}

/**
 * Remove one execution's spawn marker. Called from the process-close
 * handler so a finished execution's marker doesn't linger and mislink a
 * later `ocr state begin`. Idempotent — already-removed is fine.
 */
export function clearSpawnMarker(ocrDir: string, executionUid: string): void {
  try {
    unlinkSync(spawnMarkerPath(ocrDir, executionUid))
  } catch {
    /* already gone */
  }
}

/**
 * Remove every spawn marker (the whole directory) plus the legacy
 * single-file marker. Called on dashboard startup/shutdown — there is no
 * per-execution context there, and any marker that outlived its
 * dashboard process is stale by definition.
 */
export function clearAllSpawnMarkers(ocrDir: string): void {
  try {
    rmSync(spawnMarkerDir(ocrDir), { recursive: true, force: true })
  } catch {
    /* nothing to remove */
  }
  try {
    unlinkSync(legacySpawnMarkerPath(ocrDir))
  } catch {
    /* legacy marker absent — expected */
  }
}
