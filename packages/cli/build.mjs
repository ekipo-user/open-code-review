import { readFileSync, cpSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync('package.json', 'utf-8'))

const cjsBanner = 'import { createRequire as _cjsReq } from "module"; const require = _cjsReq(import.meta.url);'

// Main CLI entry point
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  minify: false,
  banner: {
    js: ['#!/usr/bin/env node', cjsBanner].join('\n'),
  },
  define: { __CLI_VERSION__: JSON.stringify(version) },
  tsconfig: 'tsconfig.json',
})

// Shared library subpath exports.
//
// Each of these is consumed by @open-code-review/dashboard via its
// own esbuild bundling. Library bundles must NOT carry the `cjsBanner`
// — the dashboard bundle adds its own banner once at the top, and
// duplicating the `_cjsReq` declaration via repeated banners across
// inlined subpath bundles produces a `SyntaxError: Identifier
// '_cjsReq' has already been declared` at runtime. The library code
// constructs its own `createRequire` inline (e.g. `db/index.ts`
// `locateWasm`), so no module-scope `require` is needed here.
//
// `cross-spawn` is externalized on EVERY library bundle: it is a
// CommonJS package that does an internal `require('child_process')`,
// and inlining it into an ESM bundle (no `createRequire` banner here)
// produces `Error: Dynamic require of "child_process" is not supported`
// at runtime — exactly the failure that broke the dashboard UI e2e.
// Several of these subpaths reach `@open-code-review/platform` →
// `spawn.ts` → cross-spawn transitively (e.g. models.ts, db/index.ts's
// liveness/maintenance, state/index.ts); externalizing it everywhere is
// a harmless no-op where unused and future-proofs new transitive paths.
// node's ESM resolver loads the real package at runtime (cross-spawn is
// a runtime dependency of @open-code-review/dashboard).
const COMMON_EXTERNALS = ['cross-spawn']
const libraryBundle = (entryPoint, outfile, externals = []) => ({
  entryPoints: [entryPoint],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  minify: false,
  external: [...COMMON_EXTERNALS, ...externals],
  tsconfig: 'tsconfig.json',
})

await build(libraryBundle('src/lib/db/index.ts', 'dist/lib/db/index.js'))
// Test-only helper (`@open-code-review/cli/test-support`). Built into dist
// because the dashboard's vitest externalizes workspace packages and resolves
// `cli/*` subpaths through `exports` → dist (source aliases are provably dead
// there; see dashboard/vitest.config.ts).
//
// `./index.js` (the db bundle) is externalized — NOT inlined. This is load-
// bearing: `removeTempWorkspace` calls `closeAllDatabases`, which drains a
// MODULE-LEVEL connection cache. The dashboard opens its handles through the
// `cli/db` dist bundle, so the close must hit THAT bundle's cache singleton.
// Bundling db/index into test-support would give it a second, private copy of
// that cache — the drain would no-op against an empty map and the dashboard's
// real handles would stay open, leaving `ocr.db` locked → EBUSY on the Windows
// teardown unlink (issue #41, exactly the failure this helper exists to kill;
// it passes on POSIX, which tolerates unlinking an open file). Keeping
// `./index.js` external makes test-support.js import the one shared singleton
// at runtime — the emitted output is sibling-relative, so it resolves to
// dist/lib/db/index.js next to it.
await build(
  libraryBundle('src/lib/db/test-support.ts', 'dist/lib/db/test-support.js', ['./index.js']),
)
await build(libraryBundle('src/lib/runtime-config.ts', 'dist/lib/runtime-config.js'))
// `yaml` is CommonJS-published, and inlining it via esbuild emits a
// `require()` call that fails when the consuming dashboard server is
// loaded in dev mode (tsx watch, no `createRequire` banner). Keeping it
// external means node's ESM resolver picks the package's own entry point
// at runtime — works in both dev mode and production-bundled mode.
await build(libraryBundle('src/lib/team-config.ts', 'dist/lib/team-config.js', ['yaml']))
await build(libraryBundle('src/lib/models.ts', 'dist/lib/models.js'))
await build(libraryBundle('src/lib/vendor-resume.ts', 'dist/lib/vendor-resume.js'))
await build(libraryBundle('src/lib/state/index.ts', 'dist/lib/state/index.js'))

// Copy dashboard dist into CLI dist (cross-platform, replaces Unix-only cp -r)
const dashboardSrc = resolve('..', 'dashboard', 'dist')
const dashboardDest = resolve('dist', 'dashboard')
rmSync(dashboardDest, { recursive: true, force: true })
cpSync(dashboardSrc, dashboardDest, { recursive: true })
