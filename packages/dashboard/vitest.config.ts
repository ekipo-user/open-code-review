import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      // Workspace: resolve cross-package imports to source TypeScript files.
      // The published packages use dist/ via conditional exports, but in the
      // monorepo vitest needs the source files directly.
      '@open-code-review/cli/db': resolve(__dirname, '../cli/src/lib/db/index.ts'),
      '@open-code-review/cli/exit-codes': resolve(
        __dirname,
        '../cli/src/lib/state/exit-codes.ts',
      ),
      '@open-code-review/cli/vendor-resume': resolve(
        __dirname,
        '../cli/src/lib/vendor-resume.ts',
      ),
      '@open-code-review/platform': resolve(__dirname, '../shared/platform/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/packages/dashboard',
    },
  },
})
