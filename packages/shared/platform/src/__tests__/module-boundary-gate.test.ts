/**
 * Fitness-function self-test (code-review SF#1): proves the module-boundary gate
 * (`@nx/enforce-module-boundaries`, root `eslint.config.mjs`) is actually ARMED.
 *
 * A lint gate verified only by hand at authoring time can silently rot back into
 * a no-op — a `@nx/eslint-plugin` option rename, an `error` -> `warn` downgrade,
 * a widened `allow`, or a `projectType` change could leave CI green while the gate
 * does nothing. This test runs the REAL ESLint over a planted forbidden import
 * (`dashboard -> cli`, the exact inverted edge a predecessor PR removed) and
 * asserts it fails — and that a legal `dashboard -> shared` import passes.
 *
 * It spawns ESLint via `node <eslint.js>` (not `.bin/eslint`) so it is robust on
 * Windows too, where the unit suite also runs.
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const REPO_ROOT = resolve(import.meta.dirname, '../../../../..')
// eslint's `exports` map blocks `require.resolve('eslint/bin/eslint.js')`;
// derive it from the (exported) package.json, falling back to the hoisted path.
function resolveEslintEntry(): string {
  try {
    return join(dirname(require.resolve('eslint/package.json')), 'bin/eslint.js')
  } catch {
    return resolve(REPO_ROOT, 'node_modules/eslint/bin/eslint.js')
  }
}
const ESLINT_JS = resolveEslintEntry()

// Planted files must live inside a tagged application project so the boundary
// rule resolves their source project (here: the dashboard app, `scope:dashboard`).
const DASHBOARD_SRC = resolve(REPO_ROOT, 'packages/dashboard/src/server')

type LintResult = { code: number; output: string }

function lintSnippet(fileName: string, contents: string): LintResult {
  const file = join(DASHBOARD_SRC, fileName)
  writeFileSync(file, contents)
  try {
    execFileSync(process.execPath, [ESLINT_JS, file], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      env: { ...process.env, NX_DAEMON: 'false' },
    })
    return { code: 0, output: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer }
    return {
      code: e.status ?? 1,
      output: `${e.stdout?.toString() ?? ''}\n${e.stderr?.toString() ?? ''}`,
    }
  } finally {
    rmSync(file, { force: true })
  }
}

describe('module-boundary gate is armed', () => {
  it('FAILS on a forbidden app->app import (dashboard -> cli)', () => {
    const result = lintSnippet(
      '__boundary_canary_violation__.ts',
      "import '@open-code-review/cli'\nexport {}\n",
    )
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/enforce-module-boundaries/)
  }, 60_000)

  it('PASSES on a legal app->shared import (dashboard -> platform)', () => {
    const result = lintSnippet(
      '__boundary_canary_ok__.ts',
      "import '@open-code-review/platform'\nexport {}\n",
    )
    expect(result.code, result.output).toBe(0)
  }, 60_000)
})
