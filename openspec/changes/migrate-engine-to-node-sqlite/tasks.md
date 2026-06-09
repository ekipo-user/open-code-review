# Tasks: Migrate the SQLite engine to `node:sqlite` (v2.1.0)

## 1. Engine
- [x] 1.1 Rewrite `engine.ts` on `node:sqlite` (`DatabaseSync`): `exec` via `columns()`/`setReturnArrays`,
      `run`, `pragma` via `exec`, `probeEngine`, `openEngine`.
- [x] 1.2 `transaction()` — hand-rolled `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` + bounded SQLITE_BUSY retry +
      SAVEPOINT nesting; `isBusyError` keys on `errcode` (5/261); idempotent `close()`.
- [x] 1.3 Lazy-load `node:sqlite` (so the Node-version guard + warning filter run first).

## 2. Runtime floor + guard
- [x] 2.1 `engines.node` → `>=22.5.0` (cli + root).
- [x] 2.2 `runtime-guard.ts` (Node ≥22.5 guard + experimental-warning filter), imported first in `src/index.ts`.

## 3. Remove the native engine (direct cutover)
- [x] 3.1 Delete `native-binding.ts` + its test, `NativeEngineError`, the native-binding barrel re-exports.
- [x] 3.2 Delete the 8 `packages/sqlite-*` prebuilt packages.
- [x] 3.3 Remove `better-sqlite3` + `@types/better-sqlite3` from cli + dashboard; drop the cli
      `optionalDependencies`; remove `better-sqlite3` from `build.mjs` + the dashboard build externals.
- [x] 3.4 Refresh stale "better-sqlite3" doc comments; `doctor` reports `node:sqlite`.

## 4. Tests
- [x] 4.1 `projection-and-concurrency.test.ts` child writer → `node:sqlite` (cross-process WAL test stays green).
- [x] 4.2 New `engine.test.ts`: `isBusyError` errcode discrimination + nested-savepoint commit/rollback.
- [x] 4.3 cli unit (311) + db/state (215) + dashboard (331) + cli-e2e (40) green on node:sqlite.

## 5. Docs
- [x] 5.1 README + Quick Start: Node `>= 22.5`; "built-in node:sqlite, no native module, any package manager".

## 6. Release CI
- [ ] 6.1 Rewrite `.github/workflows/release.yml`: drop the prebuild/ABI matrix; keep `setup` + `publish`
      (cli + agents) + a ~6-cell `verify-install` (pnpm 10 scripts-blocked + npm × Node 22/24 → `ocr doctor`
      loads the engine + a real DB command).

## 7. Validation + release
- [ ] 7.1 `openspec validate migrate-engine-to-node-sqlite --strict`.
- [ ] 7.2 Manual dogfood: `ocr doctor` shows the engine loaded; a Node-<22.5 run prints the guard message.
- [ ] 7.3 Ship 2.1.0; release notes lead with Node ≥22.5 + the built-in engine; `openspec archive`.
