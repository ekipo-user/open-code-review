/**
 * Managed temp-workspace lifecycle for DB-backed unit tests (issue #41).
 *
 * Every suite that opens a real `node:sqlite` database inside a per-test temp
 * dir owns that handle's lifecycle: the handle MUST be closed before the
 * directory is removed. On Windows an open database handle locks `ocr.db` and
 * a bare `rmSync` dies with EBUSY — the exact failure that left the Windows
 * unit leg permanently red (POSIX merely tolerated the leak, so it went
 * unnoticed). `closeAllDatabases` drains the shared connection cache in
 * `@open-code-review/persistence`; the dashboard's `openDb` delegates to the same
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
 * `@open-code-review/persistence/test-support` subpath. Do not re-introduce per-suite
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
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    // A failure here after a clean close means an in-process handle truly
    // leaked (or a Windows AV/indexer held the dir past the full 1s retry
    // budget). Name the dir so a Windows CI failure surfaces the path
    // directly instead of forcing a re-derivation from the stack, then
    // rethrow — this MUST fail loudly (see the module docstring).
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`removeTempWorkspace: could not remove ${dir}: ${reason}`);
  }
}

/**
 * @internal — test-only handle on the db bundle's `closeAllDatabases`, exposed
 * solely so the cross-bundle singleton invariant can be pinned by a named test
 * (issue #41, SF3-pin). `@open-code-review/persistence` and
 * `@open-code-review/persistence/test-support` MUST resolve to ONE module instance so a
 * drain here hits the same connection cache `openDatabase()` populates; that is
 * enforced by externalizing `./index.js` from this bundle (`build.mjs`). The
 * invariant test asserts this reference is identical to the one `cli/db`
 * exports — if a future build inlined `./index.js`, the references would differ
 * and the test would fail rather than silently re-splitting the cache and
 * reopening the Windows EBUSY teardown bug.
 */
export const __internalCloseAllDatabases = closeAllDatabases;
