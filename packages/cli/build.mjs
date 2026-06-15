import { readFileSync, cpSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const { version } = JSON.parse(readFileSync('package.json', 'utf-8'))

const cjsBanner = 'import { createRequire as _cjsReq } from "module"; const require = _cjsReq(import.meta.url);'

// Single bundle: the CLI entry point. esbuild inlines every workspace dependency
// it reaches (the source-only shared packages @open-code-review/persistence,
// @open-code-review/config, @open-code-review/platform — each resolves through
// its `exports` to `src/*.ts`), so the published tarball carries that code with
// no shared/* runtime dependency. The cjsBanner provides `require` for the
// CommonJS deps inlined here (cross-spawn → child_process, yaml). There are NO
// library-subpath bundles: cli exposes only `.`; the dashboard now consumes the
// shared packages directly as source, not cli's dist.
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

// Copy dashboard dist into CLI dist (cross-platform, replaces Unix-only cp -r),
// so the published cli ships the prebuilt dashboard it serves.
const dashboardSrc = resolve('..', 'dashboard', 'dist')
const dashboardDest = resolve('dist', 'dashboard')
rmSync(dashboardDest, { recursive: true, force: true })
cpSync(dashboardSrc, dashboardDest, { recursive: true })
