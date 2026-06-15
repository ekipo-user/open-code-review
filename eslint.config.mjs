// Flat ESLint config — SCOPED to exactly ONE job: enforce the module-boundary
// DAG. It is the CI-enforced version of the CLAUDE.md invariant "apps never
// depend on apps; shared depends only on shared" (code-review SF#1), keyed off
// the `scope:*` tags every project.json already carries.
//
// Deliberately minimal: we register ONLY `@nx/enforce-module-boundaries` and no
// typescript-eslint recommended set, so this stays a dependency-graph gate — not
// a repo-wide style lint that would flag thousands of pre-existing issues. Add
// other rules in a separate, intentional change if/when the team wants them.

import nx from '@nx/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.ocr/**',
      '**/vendor/**',
      '**/*.config.{js,mjs,cjs,ts,mts,cts}',
      // Agent assets are generated/synced markdown + JSON, not a TS source graph.
      'packages/agents/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: 'module' },
    },
    // `@nx` carries the boundary rule. `@typescript-eslint` and `react-hooks`
    // are registered ONLY so the codebase's existing, intentional inline
    // `eslint-disable` directives (e.g. `react-hooks/exhaustive-deps`,
    // `@typescript-eslint/no-unused-vars`) resolve to a known rule — their rule
    // SUITES are deliberately NOT enabled here. Turning those on is a separate,
    // intentional change; until then we don't flag the (now-inert) suppressions.
    plugins: { '@nx': nx, '@typescript-eslint': tsPlugin, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: [],
          // This gate enforces the dependency *DAG* (app→shared→shared), not
          // lazy-load discipline. The CLI intentionally `await import()`s
          // `@open-code-review/persistence` on hot paths (e.g. `progress`) to
          // defer the `node:sqlite` load while static-importing it elsewhere;
          // exempt our workspace libs from the "static import of a lazy-loaded
          // library" check so that legitimate mix is not flagged here. Enforcing
          // lazy-load consistency is a separate, intentional change.
          checkDynamicDependenciesExceptions: ['@open-code-review/.*'],
          depConstraints: [
            // Shared libraries may depend ONLY on other shared libraries —
            // never on an application. Keeps the graph a DAG of app → shared.
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            // The CLI app bundles the agent assets and the shared libs; it must
            // NOT depend on the dashboard app.
            {
              sourceTag: 'scope:cli',
              onlyDependOnLibsWithTags: ['scope:cli', 'scope:shared', 'scope:agents'],
            },
            // The dashboard app depends on shared libs only; it must NOT depend
            // on the CLI app (the inverted edge this PR's predecessor removed).
            {
              sourceTag: 'scope:dashboard',
              onlyDependOnLibsWithTags: ['scope:dashboard', 'scope:shared'],
            },
            // Agent assets are leaf content — no workspace dependencies.
            { sourceTag: 'scope:agents', onlyDependOnLibsWithTags: ['scope:agents'] },
          ],
        },
      ],
    },
  },
]
