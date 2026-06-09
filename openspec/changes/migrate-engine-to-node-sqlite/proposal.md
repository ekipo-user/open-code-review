# Change: Migrate the SQLite engine to Node's built-in `node:sqlite` (v2.1.0)

## Why

`@open-code-review/cli@2.0.0` ships `better-sqlite3`, a **native** module whose binary is delivered by a
dependency **install script** (`prebuild-install || node-gyp rebuild`). **pnpm 10+ blocks dependency install
scripts by default**, so `pnpm add -g @open-code-review/cli` *installs successfully but crashes on every DB
command* — the binary was never produced. This is the same silent-failure class the v2.0 redesign set out to
eliminate.

The first fix attempt — shipping prebuilt binaries as per-platform `optionalDependencies` — was abandoned when
two facts surfaced:

1. **better-sqlite3 binaries are per-Node-ABI, not napi** (proven: a Node-20 `node-v115` binary throws
   `ERR_DLOPEN_FAILED` on Node 22; upstream ships separate `node-v108/115/127/131`). "One prebuilt per platform"
   is impossible — it would be one binary per *(platform × Node-ABI)*, a combinatorial, ever-growing CI matrix.
2. **Node 20 is EOL** (2026-04-30) — the main runtime forcing that complexity is already dead.

An architecture board (Lead Architect, Principal/Data Engineer, Release Engineer, Martin Fowler) **unanimously
recommended migrating to Node's built-in `node:sqlite`**, and the Data Engineer proved (in throwaway processes)
that it satisfies every hard requirement of the v2 redesign: synchronous prepared statements, WAL on disk,
`busy_timeout`/`foreign_keys`/`synchronous`, `BEGIN IMMEDIATE`, and **cross-process concurrent writes with
SQLITE_BUSY surfacing**. It deletes the entire native-binary problem class — and the original pnpm-10 break
becomes **structurally impossible**.

## What Changes

- **BREAKING (engine):** Replace `better-sqlite3` with **Node's built-in `node:sqlite`** (`DatabaseSync`) behind
  the existing `engine.ts` adapter (the single seam). No native dependency, no prebuilt binary, no install
  script — installs cleanly under npm, **pnpm 10+**, and yarn on every platform.
- **BREAKING (engines):** Raise `engines.node` from `>=20.0.0` to **`>=22.5.0`** (when `node:sqlite` landed).
  Node 20/21 are EOL. A too-old runtime gets a **clear guard message**, not a `Cannot find module 'node:sqlite'`
  crash — the CLI entry runs the guard + an experimental-warning filter before the engine loads (the engine
  itself loads `node:sqlite` lazily).
- **Engine internals:** hand-rolled `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` with the existing bounded
  SQLITE_BUSY retry; **SAVEPOINT-based nesting** (better-sqlite3 did this automatically); `isBusyError` keys on
  `errcode` (5/261) — node:sqlite's error shape; idempotent `close()`.
- **REMOVED:** `better-sqlite3` (cli + dashboard deps + `@types`), the per-platform prebuilt packages, the
  `native-binding.ts` loader + `NativeEngineError`, the `optionalDependencies`, and the prebuilt CI matrix.
- **Released as v2.1.0** (minor — the engines floor is raised). Direct cutover: no fallback engine. The on-disk
  SQLite file format is engine-independent, so existing databases migrate with no data change.

## Impact

- **Affected specs:** `sqlite-state` (the engine: built-in `node:sqlite` + WAL, `BEGIN IMMEDIATE`,
  cross-process serialization, busy-retry; retires the `sql.js`/`DbSyncWatcher` merge-before-write language),
  `cli` (distribution + the Node ≥22.5 runtime floor: installs with no native build under any package manager,
  a clear too-old-Node guard, no warning leak, install-verified under npm + pnpm 10 in CI; drops the stale
  `sql.js` example from *Zero Dashboard Startup Cost*), and `dashboard` (*Zero Native Dependencies* updated to
  built-in `node:sqlite` + Node ≥22.5).
- **Affected code:** `packages/cli/src/lib/db/engine.ts` (rewrite), `packages/cli/src/lib/runtime-guard.ts`
  (new) + `src/index.ts` (imports it first), `packages/cli/src/commands/doctor.ts`,
  `packages/cli/src/lib/db/index.ts`, `packages/cli/package.json` + root `package.json` (engines, deps),
  `packages/dashboard/package.json` + build script, `packages/cli/build.mjs` (node22 target, no externals),
  `projection-and-concurrency.test.ts` + new `engine.test.ts`, README, `.github/workflows/release.yml`.
- **Not** doing a WASM/sql.js fallback (would re-introduce the concurrency-clobber class v2.0 deleted) and
  **not** keeping better-sqlite3 as a dual-engine fallback (the board rejected running two engines).
- The fix is **not retroactive** to a broken 2.0.0 install — the GitHub release notes lead with the Node-≥22.5
  requirement and the `pnpm add -g …@latest` upgrade.
