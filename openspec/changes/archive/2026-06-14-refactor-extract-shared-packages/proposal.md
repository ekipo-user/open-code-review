# Change: Extract shared persistence + config packages from `cli`

## Why

The `cli` package serves double duty: it is the user-facing CLI application **and**
the home of the persistence, domain, and configuration layers that the `dashboard`
server also needs. To share them, `cli` exposes 8 package subpath exports, and the
`dashboard` imports **7 of those 8** (`cli/db` alone at 38 sites) while **never**
importing the `.` CLI entry. The dashboard does not depend on the CLI — it depends
on the libraries that happen to live inside the CLI's package. The manifest makes
this dishonest: `dashboard` declares `@open-code-review/cli` as a **devDependency**
yet imports `cli/db` at runtime; it only works because esbuild inlines cli's
library bundles into the dashboard server bundle.

A recently-added convention (the "S27 graduation rule" in `CLAUDE.md`) says to
extract a `@open-code-review/storage` package only "when a 9th subpath is added."
That trigger is a mechanical proxy, not a cause: export-surface *width* was never
the problem — the boundary was crossed the moment a *second* app imported the
domain, which is already true. The trigger also scopes the fix too narrowly
(storage only, leaving `models`/config/`vendor-resume` inverted) and encodes a
deferral as policy, freezing the wrong shape.

This is the same "shared lib consumed by multiple apps" pattern the repo already
blesses with `@open-code-review/platform` — so the correct shape exists; one slice
was simply missed.

## What Changes

- **BREAKING (internal only)**: extract the shared lower layers out of `cli` into
  dedicated **source-only** packages under `packages/shared/*`, so both `cli` and
  `dashboard` depend on them instead of `dashboard` depending on `cli`:
  - `@open-code-review/persistence` — `db/` + `state/` + `vendor-resume` +
    `test-support` + `runtime-checks`. `db` and `state` are **one** package because
    they form a mutually-recursive type cycle (`db/types.ts` imports `state/types`,
    `state/index.ts` imports `../db`); splitting them would create a package cycle.
    `runtime-checks` (the `node:sqlite` precondition logic) moves with `db` because
    the engine depends on it.
  - `@open-code-review/config` — `runtime-config` + `team-config` + `models`.
- **Reverse the inverted edge**: the `dashboard → cli` runtime dependency is
  removed; `dashboard` and `cli` both depend on the new shared packages.
- **Mirror the `platform` precedent exactly — source-only, no build**: the new
  packages are `private: true`, version `0.0.0`, declared as
  `devDependency: workspace:*`, and **source-only** (every `exports` condition —
  `types`/`source`/`default` — points at `src/*.ts`; there is **no** `build.mjs`,
  no `dist`, and no `build` target). esbuild inlines the `.ts` source when bundling
  `cli`/`dashboard`; vitest/vite-node transforms it on the fly. They are **not**
  published, do **not** join the fixed `cli`+`agents` release group, and require
  **no** npm trusted-publisher changes.
- **The connection-cache singleton needs no workaround**: under source consumption
  there is one module instance per process/bundle (vite-node and esbuild dedup by
  resolved path), so `db`'s connection cache is naturally shared. The old
  `test-support → ./index.js` external trick (issue #41) is **deleted**, not
  preserved — it was an artifact of the per-subpath dist bundles that no longer
  exist.
- **Behavior-preserving**: no observable behavior changes. Every moved module keeps
  its public surface; existing tests pass unchanged (re-pointed imports only). No
  DB migration, no schema change, no runtime-config change.
- **Retire the S27 rule**: replace the "9th subpath" bullet in `CLAUDE.md` with a
  cause-based graduation rule (a slice graduates to a `shared/*` package when it is
  consumed across the package boundary, not merely by `cli`'s own app code).
- **Direct cutover — nothing deprecated left behind**: there are no transitional
  `cli` re-export shims. The 7 library subpath exports, the `cli:build:lib` target,
  and the library-subpath bundling in `cli/build.mjs` are removed in the same change
  that moves the modules.

## Impact

- Affected specs: `package-architecture` (new capability)
- Affected code:
  - New: `packages/shared/persistence/`, `packages/shared/config/` (package.json,
    project.json, tsconfig*, vitest.config.ts — no build.mjs)
  - Moved out of `packages/cli/src/lib/`: `db/`, `state/`, `runtime-checks.ts`,
    `vendor-resume.ts` → `persistence`; `models.ts`, `runtime-config.ts`,
    `team-config.ts` → `config`
  - `packages/cli/package.json` (drop 7 subpath exports → keep only `.`, add shared
    devDeps), `packages/cli/build.mjs` (collapse to a single `index.ts` bundle +
    dashboard-dist copy), `packages/cli/project.json` (drop `build:lib`), and
    cli-internal import re-points to the new package specifiers
  - `packages/dashboard/` ~36 import-site rewrites (`@open-code-review/cli/*` → new
    packages), `package.json` deps, `project.json` (`test.dependsOn` removed),
    `vitest.config.ts` (aliases/inline apparatus removed — packages resolve to
    source by construction)
  - `CLAUDE.md` (replace the S27 graduation-rule bullet)
  - `openspec/config.yaml` (the "Three-package monorepo" description)
