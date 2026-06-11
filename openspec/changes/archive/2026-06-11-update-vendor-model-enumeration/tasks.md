# Tasks — update-vendor-model-enumeration

## 1. CLI model-discovery library (single source of truth)

- [x] 1.1 Refactor `packages/cli/src/lib/models.ts` into the per-vendor
      strategy table; export `SUPPORTED_VENDORS`, `isModelVendor`, and pure
      per-vendor parsers
- [x] 1.2 OpenCode strategy: probe `["models"]`, line parser (CRLF-safe,
      `^\S+/\S+$` filter, provider from slash prefix, zero matches → failure)
- [x] 1.3 Claude strategy: `native: { unavailableReason }` (curated string);
      bundled list becomes aliases `opus` / `sonnet` / `haiku`
- [x] 1.4 Make `listModelsForVendor` / `detectActiveVendor` async via
      `execBinaryAsync`; capture probe stderr into
      `nativeUnavailableReason`; add 60s per-vendor TTL cache
- [x] 1.5 Rewrite `models.test.ts` hermetically (`vi.mock` of
      `@open-code-review/platform`): parser cases, probe-failure reasons
      (ENOENT vs non-zero), argv pin (`opencode`, `["models"]`), cache,
      claude no-probe pin, parameterized probe matrix over strategies with
      a native probe

## 2. CLI command + dashboard server

- [x] 2.1 `packages/cli/src/commands/models.ts`: validate via
      `isModelVendor`; await async lib; print reason note; `--json` emits the
      envelope (and null envelope when no vendor detected)
- [x] 2.2 `packages/dashboard/src/server/routes/team.ts`: async handler;
      vendor validation derives from `SUPPORTED_VENDORS`; passes
      `nativeUnavailableReason` through
- [x] 2.3 Delete `listModels()` from `AiCliAdapter` interface, both
      adapters (and their bundled lists), and the session-capture test stub;
      delete the server-side duplicate `ModelDescriptor`
- [x] 2.4 Contract test: every `AiCliService` registered adapter binary is in
      `SUPPORTED_VENDORS`
- [x] 2.5 Amend `evolve-phase4-host-aware-spawning/tasks.md` 3.1–3.2 to
      register strategy-table entries instead of implementing `listModels`

## 3. Dashboard client

- [x] 3.1 `api-types.ts`: add `nativeUnavailableReason?` to
      `ModelListResponse`
- [x] 3.2 `ModelSelect`: render unknown non-empty values as a "(custom)"
      option; add always-available "Custom…" free-text escape (sentinel must
      not leak into team state)
- [x] 3.3 Consolidate the team-composition-panel's inline `ModelPicker` onto
      the shared `ModelSelect`
- [x] 3.4 Bundled-source hint (shared element) in panel, reviewer dialog,
      and default team section

## 4. E2E regression coverage

- [x] 4.1 `packages/cli-e2e/src/helpers/vendor-stubs.ts`: argv-strict stub
      generator (`.cjs` core + sh wrapper + `.cmd` shim, written on all
      OSes), behaviors: native (LF/CRLF), garbage, exit-127, tripwire;
      case-insensitive PATH-key env merge
- [x] 4.2 cli-e2e: per-strategy cases — opencode native success (exact ids,
      `source: "native"`), malformed → bundled + reason contains stub
      stderr/noise, absent → bundled; claude → bundled + curated reason +
      tripwire marker absent; replace the loophole assertions in the
      existing `ocr models list` block with the envelope shape
- [x] 4.3 `server-harness.ts`: opt-in `env` param; dashboard-api-e2e tests
      for `GET /api/team/models` (native success, malformed → bundled +
      reason, `vendor=auto` pin, unknown vendor 400)
- [x] 4.4 Dispatch `cross-platform-test.yml` for `windows-latest` +
      `macos-latest` on the branch before merge (PR CI is ubuntu-only)

## 5. Verification

- [x] 5.1 `pnpm nx run-many -t typecheck build test -p platform cli dashboard`
- [x] 5.2 `pnpm nx e2e cli-e2e` and `pnpm nx e2e dashboard-api-e2e`
- [x] 5.3 Manual smoke: `ocr models list` (both vendors) + dashboard dropdown
      against the real installed CLIs
