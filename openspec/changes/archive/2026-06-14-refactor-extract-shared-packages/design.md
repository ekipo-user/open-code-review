## Context

`cli` is both the CLI application and the de-facto shared library for `dashboard`.
An architecture-board review (three independent lenses: layering, DDD, monorepo
mechanics) reached the same conclusion: the `dashboard → cli` edge is inverted, and
the `CLAUDE.md` "S27 / 9th-subpath" rule defers a correction the codebase already
needs rather than preventing premature abstraction.

Verified ground truth:

- `cli` exports 8 subpaths: `.`, `./db`, `./state`, `./models`, `./runtime-config`,
  `./team-config`, `./vendor-resume`, `./test-support`.
- `dashboard` imports 7 of 8 (db 38 sites, test-support 9, the rest 1–2 each) and
  never imports `.`.
- `dashboard` declares `cli` as a **devDependency** but imports `cli/db` at
  runtime; it works only because esbuild inlines cli's library bundles.
- `@open-code-review/platform` already proves the pattern: `private: true`,
  `version 0.0.0`, devDep-only, **source-only** (every `exports` condition points at
  `src/*.ts`; no `build.mjs`, no `dist`, no `build` target), inlined into each app's
  bundle, and **excluded from release** via `nx.json` (`!packages/shared/*`).

## Goals / Non-Goals

- Goals:
  - Reverse the inverted edge: apps depend on shared libraries, never on each other.
  - Align package boundaries with real layers (persistence + config).
  - Preserve observable behavior exactly; no DB/schema/config changes.
  - Keep the publish model unchanged (inline shared **source** into the published
    `cli`).
  - Replace the mechanical S27 trigger with a cause-based rule.
- Non-Goals:
  - No new published npm package; no change to the `cli`+`agents` release group.
  - No behavior change, no migration, no DB integrity work (separate concern).
  - Not a rewrite of the moved modules — move + re-point imports only.

## Decisions

### Decision 1: Reverse the dependency direction via `shared/*` packages

Both apps depend on the extracted packages; the `dashboard → cli` edge is deleted.
This is the layering the `platform` package already establishes.

- Alternatives considered:
  - **Keep subpath exports + S27 rule (status quo).** Rejected: it codifies the
    inversion as intentional and only widens with each new shared module.
  - **One mega `core` package.** Rejected: it relocates the god-package rather than
    fixing the boundary; there is a genuine config context distinct from the
    persistence/domain layer.

### Decision 2: The seam is persistence + config (db and state are one package)

- `@open-code-review/persistence` = `db/` + `state/` + `vendor-resume` +
  `test-support` + `runtime-checks`. `db` is the SQLite **adapter** (engine,
  migrations, maintenance, reconcile); `state` is the workflow-aggregate lifecycle
  (begin/advance/complete-round/finish/reconcile-on-exit). They live in **one**
  package because their type modules are mutually recursive — `db/types.ts` imports
  `state/types`, and `state/index.ts` imports `../db` — so any package boundary
  drawn between them would be a dependency **cycle**, not a layer. `runtime-checks`
  (the `node:sqlite` precondition guard the engine calls) moves with `db`.
  `test-support` and `vendor-resume` are persistence-adjacent helpers consumed
  across the boundary, so they ship here too.
- `@open-code-review/config` = `runtime-config` + `team-config` + `models`. A
  configuration/catalog context distinct from review execution.

- Alternatives considered:
  - **Separate `persistence` (db) and `domain` (state) packages.** This was the
    original three-package plan. Rejected once the `db/types ↔ state/types` cycle
    was confirmed: enforcing a one-directional `domain → persistence` edge would
    require breaking the existing recursive type relationship — a behavior-touching
    refactor this change explicitly excludes. The layer distinction is preserved
    *inside* `persistence` (sibling `db/` and `state/` directories) without paying
    for an impossible package split.
  - **`storage` = db + state only (the retired S27 endpoint).** Subsumed by the
    above: db + state are inseparable, and the config slice still needs extracting.

### Decision 3: Source-only — inline, do not publish, no build step

The new packages are `private: true`, version `0.0.0`, declared
`devDependency: workspace:*`, and **source-only**: every `exports` condition
(`types`/`source`/`default`) points directly at `src/*.ts`. There is no `build.mjs`,
no `dist`, and no `build` target. esbuild inlines the TypeScript source when
bundling `cli`/`dashboard` (via `--conditions=source`); vitest/vite-node transforms
it on the fly. Because `cli` is **bundled**, a shared package does **not** have to
be published, does **not** join the fixed `cli`+`agents` release group, and needs
**no** OIDC trusted-publisher registration. The published `cli` tarball carries the
inlined source, exactly as it carries `platform` today.

- Alternatives considered:
  - **Per-subpath `dist` bundles + a `build:lib` target (the old `cli` model).**
    Rejected: it is precisely the machinery being deleted. Source-only consumption
    removes a build edge, a build artifact, and the connection-cache workaround in
    one move (see Decision 4).
  - **Make the package a published runtime dependency of `cli`.** Rejected: it would
    force a third release-group member, a new npm publisher config, and a
    version-skew matrix — all for zero benefit under the bundling model.

### Decision 4: No connection-cache workaround under source consumption

`db` keeps a module-level connection cache that `test-support`'s `closeAllDatabases`
must drain — historically the issue-#41 hazard. Under the old per-subpath dist
bundles, `test-support` and `db` could each get a private copy of that module, so
`cli` externalized `./index.js` from the test-support bundle to force one instance.
**Source-only consumption makes that unnecessary**: vite-node and esbuild dedup a
module by its resolved file path, so there is exactly one `db` module instance per
process/bundle and the cache is shared by construction. The `./index.js` external
trick is **removed**, and `test-support` simply imports `./index.js` (a normal
intra-package relative import) like any sibling. The issue-#41 behavior is still
asserted by the existing porcelain/projection tests in `persistence`.

### Decision 5: Replace S27 with a cause-based trigger

New rule (landed in `CLAUDE.md`): a slice graduates to its own `packages/shared/*`
package when it is **consumed across the package boundary** (by `dashboard`, an e2e
package, or another app) rather than by `cli`'s own application code — not when some
subpath count is reached. Genuinely cli-internal utilities stay in `cli`.

## Risks / Trade-offs

- **High-volume mechanical churn** (~36 dashboard import sites plus the cli-internal
  re-points). → Codemod the rewrites; a single `nx run-many -t typecheck` over all
  projects catches any missed specifier. (A dynamic `await import("../lib/db")` in
  `cli/commands/progress.ts` was exactly such a miss; typecheck surfaced it.)
- **The db connection-cache singleton** is no longer a hazard under source
  consumption (Decision 4); the porcelain/projection suites still assert the
  drain-and-reopen behavior on POSIX and the Windows e2e unlink path.
- **The `node:sqlite` one-seam invariant** moves with the engine. The
  `engine-seam-guard` test (which fails if any file outside `db/engine.ts` imports
  `node:sqlite`) is relocated into `persistence` and rescoped to scan all
  first-party source (cli, dashboard, and the shared libs) with the new owner path
  `shared/persistence/src/db/engine.ts`.
- **vitest source-resolution** for the new packages is automatic: their `exports`
  map every condition to `src/*.ts`, so vitest externalizes the symlinked workspace
  package, Node's resolver follows `exports` to the source, and vite-node transforms
  it — **no** `resolve.alias`, **no** `server.deps.inline`, **no** build
  `dependsOn`, exactly as `platform` has always worked.
- **The dashboard `build dependsOn: []` cycle-breaker** stays valid and is even
  safer: dashboard build consumes shared **source** (esbuild `--conditions=source`),
  so there is nothing to pre-build and no task cycle to introduce.

## Migration Plan

Direct cutover, fix-forward — no shims, nothing deprecated left behind. The change
lands as one coherent edit; the ordering below is the authoring sequence, not a set
of independently-shipped phases.

1. **Scaffold both packages.** Create `packages/shared/persistence` and
   `packages/shared/config` mirroring `platform` (source-only package.json,
   project.json with only `test` + `typecheck` targets, tsconfig*, vitest.config.ts).
2. **Move the modules.** `git mv` `db/`, `state/`, `runtime-checks.ts`,
   `vendor-resume.ts` (and their tests) into `persistence/src/`; `models.ts`,
   `runtime-config.ts`, `team-config.ts` (and tests) into `config/src/`. Sibling
   `db/`/`state/` placement preserves every intra-package relative import.
3. **Re-point all consumers in the same change.** Rewrite cli-internal imports and
   the ~36 dashboard import sites directly to the new package specifiers; add the
   shared packages as `cli`/`dashboard` devDeps; remove the `@open-code-review/cli`
   dashboard devDep.
4. **Delete the workaround machinery.** Drop the 7 subpath exports from
   `cli/package.json` (keep only `.`); collapse `cli/build.mjs` to a single
   `index.ts` bundle plus the dashboard-dist copy; remove the `cli:build:lib`
   target; remove the dashboard `test.dependsOn` build edge and the vitest
   alias/inline apparatus. Replace the S27 bullet in `CLAUDE.md`; update the
   `config.yaml` monorepo description.
5. **Verify** end to end: `nx run-many -t typecheck` (all 9 projects), all unit
   suites (cli, dashboard, persistence, config, platform), cli-e2e +
   dashboard-api-e2e + dashboard-ui-e2e, `nx run dashboard:build`, `nx run
   cli:build`, and `nx release --skip-publish --dry-run` (confirm the release set is
   `cli`+`agents` only and the `cli` bundle inlines shared source with no new runtime
   dep).

## Open Questions

- Does `models` belong in `config` (catalog) or alongside the vendor concepts?
  Settled as `config` per the DDD review; revisit if `models` grows
  review-execution logic.
- Should the `state` layer eventually expose persistence via explicit ports rather
  than the in-package `db` import? Not now — the recursive type relationship keeps
  them in one package; ports would be a separate, behavior-touching change if
  coupling pain appears.
