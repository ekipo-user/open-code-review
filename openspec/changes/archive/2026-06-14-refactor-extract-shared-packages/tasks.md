# Tasks: Extract shared persistence + config packages from `cli`

Direct cutover, fix-forward — no transitional `cli` re-export shims, nothing
deprecated left behind. The whole change lands coherently; the ordering below is the
authoring sequence.

## 1. Scaffold the two source-only shared packages

- [x] 1.1 Scaffold `packages/shared/persistence` mirroring `shared/platform`:
      package.json (`private: true`, `version 0.0.0`, exports `.`→`src/db/index.ts`,
      `./state`, `./test-support`, `./vendor-resume`, `./runtime-checks` — every
      condition `types`/`source`/`default` at `src/*.ts`, no build/dist); project.json
      with only `test` + `typecheck` targets; tsconfig*/vitest.config.ts
- [x] 1.2 Scaffold `packages/shared/config` the same way: exports `./models`,
      `./runtime-config`, `./team-config`; deps `@open-code-review/platform` + `yaml`

## 2. Move the modules (db + state are one package; the type cycle forbids a split)

- [x] 2.1 `git mv packages/cli/src/lib/db/` → `packages/shared/persistence/src/db/`
      (engine, migrations, maintenance, reconcile, test-support, + tests)
- [x] 2.2 `git mv packages/cli/src/lib/state/` →
      `packages/shared/persistence/src/state/` (+ tests) — sibling placement keeps
      every `../db` ↔ `../state` intra-package relative import intact
- [x] 2.3 `git mv` `runtime-checks.ts` + `vendor-resume.ts` (+ tests) into
      `persistence/src/`
- [x] 2.4 `git mv` `models.ts`, `runtime-config.ts`, `team-config.ts` (+ tests) into
      `config/src/`
- [x] 2.5 Add `ReviewerTier`/`ReviewerMeta`/`ReviewersMeta` to the `state` barrel so
      cli consumers route through `@open-code-review/persistence/state`, not a deep
      types import

## 3. Re-point every consumer in the same change (no shims)

- [x] 3.1 Rewrite cli-internal imports to the new package specifiers (commands/*,
      lib/installer, lib/progress/*, lib/runtime-guard, and the dynamic
      `await import()` in `commands/progress.ts`)
- [x] 3.2 Rewrite the ~36 `packages/dashboard/src` import sites from
      `@open-code-review/cli/{db,state,test-support,vendor-resume,runtime-config,
      team-config,models}` to the new package paths
- [x] 3.3 Re-point the moved test files and any e2e/doc-comment references

## 4. Delete the workaround machinery + wire the manifests

- [x] 4.1 `packages/cli/package.json`: drop the 7 library subpath exports (keep only
      `.`); add `@open-code-review/persistence` + `@open-code-review/config` devDeps
- [x] 4.2 Collapse `packages/cli/build.mjs` to a single `src/index.ts` → `dist/index.js`
      bundle plus the dashboard-dist copy; delete the library bundles, `--lib-only`
      flag, COMMON_EXTERNALS, and the `libraryBundle()` helper
- [x] 4.3 Remove the `cli:build:lib` target from `packages/cli/project.json`
- [x] 4.4 `packages/dashboard`: add the two shared packages as devDeps, remove the
      `@open-code-review/cli` devDep; remove the `test.dependsOn` build edge from
      project.json; remove the vitest alias/inline apparatus (packages resolve to
      source by construction)
- [x] 4.5 Replace the S27 "9th subpath" bullet in `CLAUDE.md` with the cause-based
      graduation rule; update the monorepo description in `openspec/config.yaml`

## 5. Verify end to end

- [x] 5.1 `nx run-many -t typecheck` — all 9 projects pass
- [x] 5.2 All unit suites pass (cli, dashboard, persistence, config, platform),
      including the relocated `engine-seam-guard` (one-seam invariant, new owner
      path `shared/persistence/src/db/engine.ts`)
- [x] 5.3 `nx run dashboard:build` and `nx run cli:build` succeed; the `cli` bundle
      inlines shared source (zero `@open-code-review/*` runtime references, Node
      builtins only)
- [x] 5.4 cli-e2e + dashboard-api-e2e + dashboard-ui-e2e green
- [x] 5.5 `nx release --skip-publish --dry-run` shows the release set is
      `cli`+`agents` only (no `shared/*`) and a `cli` tarball with shared code
      inlined and no new runtime dep
- [x] 5.6 `openspec validate refactor-extract-shared-packages --strict`
