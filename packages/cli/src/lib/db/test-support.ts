/**
 * Managed temp-workspace lifecycle for DB-backed unit tests (issue #41).
 *
 * Every suite that opens a real `node:sqlite` database inside a per-test temp
 * dir owns that handle's lifecycle: the handle MUST be closed before the
 * directory is removed. On Windows an open database handle locks `ocr.db` and
 * a bare `rmSync` dies with EBUSY — the exact failure that left the Windows
 * unit leg permanently red (POSIX merely tolerated the leak, so it went
 * unnoticed). `closeAllDatabases` drains the shared connection cache in
 * `@open-code-review/cli/db`; the dashboard's `openDb` delegates to the same
 * module instance, so a single drain releases handles opened on either side.
 *
 * The retried `rmSync` then absorbs Windows handle-release lag (AV/indexer
 * transients) that can linger briefly AFTER a clean close. It deliberately
 * does NOT swallow errors: unlike e2e teardowns (whose handles belong to
 * out-of-process children), a failure here means an in-process handle leak and
 * should fail the test loudly rather than hide a regression.
 *
 * This is the single definition shared by every package's unit tests — the CLI
 * suites import it relatively, the dashboard suites via the
 * `@open-code-review/cli/test-support` subpath. Do not re-introduce per-suite
 * `closeAllDatabases(); rmSync(...)` pairs: they drift (most omitted the retry)
 * and re-open the #41 flake.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllDatabases } from "./index.js";

/** Create an isolated temp workspace dir under the OS temp root. */
export function makeTempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Close every cached database handle, then remove the workspace dir with
 * Windows-tolerant retries. Call from `afterEach`/`afterAll`.
 */
export function removeTempWorkspace(dir: string): void {
  closeAllDatabases();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
