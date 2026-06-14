/**
 * Managed temp-workspace lifecycle for the dashboard's DB-backed unit tests.
 *
 * Re-exports the single canonical helper from `@open-code-review/persistence/test-support`
 * (issue #41). The dashboard's `openDb` delegates to the same `cli/db` module
 * instance the helper drains, so `removeTempWorkspace` releases handles opened
 * on either side before removing the dir. Kept as a local re-export so the
 * capture suites import a stable in-package path; the definition lives in one
 * place. See that module for the full EBUSY rationale.
 */

export {
  makeTempWorkspace,
  removeTempWorkspace,
} from '@open-code-review/persistence/test-support'
