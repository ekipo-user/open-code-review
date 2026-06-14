/**
 * Cross-bundle DB connection-cache singleton invariant (issue #41, SF3-pin).
 *
 * `@open-code-review/persistence` (where `openDatabase()` populates a module-level
 * `connections` Map) and `@open-code-review/persistence/test-support` (whose
 * `removeTempWorkspace` drains that Map via `closeAllDatabases()`) MUST resolve
 * to ONE shared module instance. If they don't, the drain runs against an empty
 * private copy of the cache, the dashboard's real handles stay open, and
 * `ocr.db` is still locked at the Windows teardown unlink → EBUSY (the exact
 * failure SF3 exists to kill; POSIX merely tolerates the leaked handle, so the
 * regression would be invisible off-Windows).
 *
 * The invariant is enforced by externalizing `./index.js` from the test-support
 * bundle in `packages/cli/build.mjs` — a rationale comment, but a comment can't
 * fail CI. This test pins it as a named assertion: the dashboard suite resolves
 * both subpaths through `cli`'s `exports` → DIST (vitest externalizes workspace
 * packages; `dashboard:test` `dependsOn` `cli:build`), so the two references are
 * identical ONLY when the externalization holds. Inline `./index.js` into the
 * test-support bundle and this `.toBe` flips to a hard failure here rather than
 * silently re-splitting the cache and reopening #41 on the Windows leg.
 */

import { describe, expect, it } from 'vitest'
import { closeAllDatabases } from '@open-code-review/persistence'
import { __internalCloseAllDatabases } from '@open-code-review/persistence/test-support'

describe('DB connection-cache singleton across cli/db ↔ cli/test-support', () => {
  it('both subpaths resolve to the same module instance (one shared cache)', () => {
    // Same function identity ⟺ same module instance ⟺ same `connections` Map.
    expect(__internalCloseAllDatabases).toBe(closeAllDatabases)
  })
})
