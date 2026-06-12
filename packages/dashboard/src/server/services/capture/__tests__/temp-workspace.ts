/**
 * Managed temp-workspace lifecycle for DB-backed unit tests.
 *
 * The capture suites open real node:sqlite databases inside a per-test temp
 * dir. A test owns the lifecycle of every resource it acquires: the handle
 * MUST be closed before the directory is removed — on Windows an open
 * database handle locks `ocr.db` and a bare rmSync dies with EBUSY (issue
 * #41; POSIX merely tolerated the leak). `closeAllDatabases` drains the
 * shared connection cache in `@open-code-review/cli/db` — the same module
 * instance the dashboard's `openDb` delegates to.
 *
 * The retried rm absorbs Windows handle-release lag (AV/indexer transients)
 * AFTER a proper close; it deliberately does NOT swallow errors — unlike the
 * e2e teardowns (whose handles belong to out-of-process children), a failure
 * here means an in-process handle leak and should fail the test loudly.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllDatabases } from '@open-code-review/cli/db'

export function makeTempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeTempWorkspace(dir: string): void {
  closeAllDatabases()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
