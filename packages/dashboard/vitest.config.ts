import { defineConfig } from 'vitest/config'

// ── Cross-package resolution model (round-2 S3) ──
//
// Dashboard tests import two workspace packages, resolved two different ways —
// deliberately, and matching how each package publishes itself:
//
//  - `@open-code-review/platform` resolves to SOURCE: its package.json
//    `exports.default` points at `src/index.ts`, so vitest's externalized
//    (Node-driven) resolution lands on TypeScript that vite-node transforms.
//    No alias needed.
//
//  - `@open-code-review/cli/*` resolves to DIST: cli's `exports` point at
//    `dist/`, and vitest EXTERNALIZES the symlinked workspace package — Node's
//    resolver follows `exports` before vite's `resolve.alias`/`conditions`
//    ever participate. Source aliases for these subpaths were tried and are
//    provably dead (object-form, regex-form, `resolve.conditions: ['source']`,
//    and `server.deps.inline` all fail when `cli/dist` is absent — even for
//    subpaths that were aliased). The reliable mechanism is the task graph:
//    `dashboard:test` declares `dependsOn: cli:build` in project.json, so the
//    dist these tests resolve is always freshly built. Do NOT re-add source
//    aliases here — they cannot take effect and only mask the real dependency.
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
