import { defineConfig } from 'vitest/config'

// ── Cross-package resolution model ──
//
// Dashboard tests import only source-only workspace packages
// (`@open-code-review/persistence`, `@open-code-review/config`,
// `@open-code-review/platform`). Each one's package.json `exports` map every
// condition (`types`/`source`/`default`) at `src/*.ts` — there is no `dist`.
// vitest EXTERNALIZES the symlinked workspace package, Node's resolver follows
// `exports` to the TypeScript source, and vite-node transforms it on the fly.
// So NO `resolve.alias`, NO `dependsOn` on any build target, and NO
// `server.deps.inline` are needed — the packages resolve to source by
// construction, exactly as `platform` always has. (The former `cli/*` subpaths
// pointed at `dist` and forced a `dashboard:test -> cli:build:lib` edge; that
// whole apparatus was removed when persistence/config were extracted as
// source-only packages. Do NOT re-introduce a build dependency here.)
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/packages/dashboard',
    },
  },
})
