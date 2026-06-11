# Update Vendor Model Enumeration (Single-Source Strategy Table)

## Why

Issue #39: the dashboard's per-instance model dropdown and `ocr models list`
always serve a small, stale, hardcoded bundled list for every vendor. Native
enumeration silently never works, the failure is swallowed, and the payload's
`source` field is never surfaced.

### Root cause, per vendor strategy (empirically verified 2026-06-11)

**Claude Code (v2.1.153):** there is no model-listing subcommand at all. The
full subcommand list is `agents, auth, auto-mode, doctor, install, mcp,
plugin, project, setup-token, ultrareview, update`; the probe OCR shells —
`claude models --json` — exits 1 with `error: unknown option '--json'`. Native
enumeration can never succeed, so the claude dropdown is permanently the
bundled trio (`claude-opus-4-7` generation — already stale).

**OpenCode (v1.17.0):** `opencode models [provider]` exists and works, but it
emits newline-delimited plain-text ids (`opencode/big-pickle`, exit 0). OCR
probes `opencode models --json` — `--json` is an unknown option (exit 1, yargs
help on stderr) — and then `JSON.parse`s expecting an array. Wrong invocation
plus wrong parser: native enumeration never succeeds even though the vendor
genuinely supports it.

**Cross-cutting:** `tryNativeEnumeration` swallows every failure (including
the diagnostic stderr — `stdio` ignores it), the UI never renders
`source: "bundled"`, and the free-text escape hatch only appears when the
model list is empty, which never happens because the bundled list is always
non-empty. A duplicated, dead enumeration path (`AiCliAdapter.listModels()` in
both dashboard adapters, zero live call sites) re-encodes the same broken
probe and its own copy of the bundled lists. The existing e2e only asserts
shape that passes for both native and bundled output, which is how this
regressed invisibly.

## What Changes

- **Single source of truth:** refactor `packages/cli/src/lib/models.ts` into a
  per-vendor model-listing strategy table (probe argv + output parser + bundled
  fallback + unavailability reason). Derived exports (`SUPPORTED_VENDORS`,
  `isModelVendor`) replace the hardcoded vendor literals in the dashboard route
  and the CLI command, so a future vendor (Codex, Gemini CLI, …) registers in
  exactly one place.
- **OpenCode strategy:** probe `opencode models` (no `--json`) and parse
  newline-delimited `provider/model` lines (CRLF-safe, noise-filtered; zero
  matching lines is a failure, not an empty success).
- **Claude strategy:** declares native enumeration unsupported with a curated
  reason (no speculative probe of a command proven not to exist). Its bundled
  list becomes the vendor-documented aliases (`opus`, `sonnet`, `haiku`), which
  cannot go stale — fixing the staleness class, not the instance.
- **Observability:** `ModelListResult` gains `nativeUnavailableReason?`
  (curated reason or probe failure detail including captured stderr), present
  whenever `source` is `"bundled"`. Surfaced by `ocr models list`, the
  dashboard payload, and a hint in the dropdown UI. `ocr models list --json`
  emits the full envelope (`{ vendor, source, models, nativeUnavailableReason? }`)
  instead of a bare array. **BREAKING** (CLI `--json` output shape; no known
  consumers — the dashboard uses the HTTP route, agents assets do not call it).
- **Async + cached:** enumeration and vendor detection become async
  (`execBinaryAsync`) with a short per-process TTL cache, removing up to ~11s
  of synchronous event-loop blocking per dropdown load on the dashboard server.
- **Delete the dead path:** remove `listModels()` from `AiCliAdapter`, both
  adapters, and the test stub; delete the dashboard server's duplicate
  `ModelDescriptor`. A contract test pins that every registered adapter binary
  is a strategy-table vendor, so the two surfaces cannot drift.
- **UI:** all three model-picker surfaces (team composition panel, reviewer
  dialog, default team section) consolidate on the shared `ModelSelect`, which
  gains an always-available "Custom…" free-text escape, renders unknown saved
  model ids as a custom option (instead of blank/default), and shows a
  bundled-source hint.
- **E2E:** per-strategy coverage via stub vendor binaries on PATH (strict argv
  dispatch so reintroducing `--json` fails loudly): native success, malformed
  native output, vendor-unavailable fallback, plus a claude tripwire pinning
  that no probe is spawned. Covered through both `ocr models list --json`
  (cli-e2e) and `GET /api/team/models` (dashboard-api-e2e).
- Amend `evolve-phase4-host-aware-spawning` task 3.1/3.2 so future adapters
  register a strategy-table entry instead of implementing `listModels`.

## Impact

- Affected specs: `cli` (`ocr models` Subcommand), `dashboard` (Team
  Composition Panel, New Server Routes).
- Affected packages: `cli` (lib + command), `dashboard` (server route, ai-cli
  types/adapters, client api-types + three picker surfaces), `cli-e2e`,
  `dashboard-api-e2e`, `shared/platform` (none — `execBinaryAsync` exists).
- **BREAKING** (narrow): `ocr models list --json` output becomes an envelope
  object. The dashboard HTTP payload only gains an optional field.
- Supersedes the model-enumeration half of PR #32 (which patched the JSON
  probe in both duplicated paths, without tests or the claude-side fix).
