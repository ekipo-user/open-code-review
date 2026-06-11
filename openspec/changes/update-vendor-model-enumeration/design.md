# Design — Vendor Model Enumeration Strategy Table

## Context

Evidence gathered 2026-06-11 on macOS (Claude Code 2.1.153, OpenCode 1.17.0):

```
$ claude models --json        # exit 1
error: unknown option '--json'
# `claude --help` subcommands: agents, auth, auto-mode, doctor, install,
# mcp, plugin, project, setup-token, ultrareview, update — no `models`.

$ opencode models --json      # exit 1 (yargs unknown option, help on stderr)
$ opencode models             # exit 0
opencode/big-pickle
opencode/deepseek-v4-flash-free
opencode/mimo-v2.5-free
opencode/nemotron-3-ultra-free
opencode/north-mini-code-free
# `opencode models --verbose` interleaves pretty-printed JSON metadata
# blocks per id — unsuitable for line parsing; plain form is the contract.
```

Live consumer graph: dashboard `GET /api/team/models` (routes/team.ts) and
`ocr models list` both call `listModelsForVendor` in
`packages/cli/src/lib/models.ts`. `AiCliAdapter.listModels()` (both dashboard
adapters) has zero call sites — dead duplicate. Dependency direction is
dashboard → cli, so the cli lib is the only possible single source of truth.

## Decisions

### 1. Per-vendor strategy table in the cli model-discovery lib

```ts
type VendorModelStrategy = {
  displayName: string
  native:
    | { args: string[]; parse: (stdout: string) => ModelDescriptor[] | null }
    | { unavailableReason: string }   // vendor has no enumeration command
  bundled: ModelDescriptor[]
}
const VENDOR_MODEL_STRATEGIES: Record<ModelVendor, VendorModelStrategy>
```

`SUPPORTED_VENDORS` and `isModelVendor()` derive from the table; the dashboard
route and the CLI command validate against them instead of literal unions.
Parsers are exported pure functions so unit tests are hermetic.

### 2. Claude: declared-unsupported, not a speculative probe

Alternatives considered:

- **(a) keep probing `claude models --json` forever** — self-healing only if
  Anthropic ships exactly that command with exactly that output shape; spawns
  a known-dead process on every (now async) enumeration; produces a noisy
  meaningless failure reason. Rejected: you cannot contract-test a contract
  that does not exist, and the speculative probe is the original sin that
  masked this bug.
- **(b) `native: { unavailableReason }`** — honest, zero wasted spawns, the
  reason string is curated and user-facing. When Claude Code ships
  enumeration, the change is one table entry plus a parser, which the
  parameterized probe-machinery tests then cover automatically. **Chosen.**

E2E pins the negative with a tripwire stub: a `claude` stub that would answer
`models` and records being invoked — the test asserts bundled + curated
reason + the stub was never spawned.

### 3. Claude bundled list = vendor aliases, not dated ids

For claude the bundled list is not a fallback — it is the permanent source
(no native enumeration exists). Dated ids (`claude-opus-4-7`, …) recreate the
staleness bug by construction. Claude Code documents model aliases
(`--model … 'sonnet' or 'opus' …`), which are vendor-native and track the
latest generation automatically. Bundled list: `opus`, `sonnet`, `haiku`.
Pinned dated ids remain available via free-text (vendor-validated, never
gatekept). OpenCode keeps dated ids (refreshed) — its bundled list is a true
fallback, since native enumeration now works.

### 4. Async enumeration + TTL cache

`execFileSync` probes on the dashboard request path block the entire Node
event loop (probe timeout 5s; `vendor=auto` adds up to 2×3s detection). The
strategy runner uses `execBinaryAsync`; `listModelsForVendor` and
`detectActiveVendor` become async; the route handler awaits. A module-level
TTL cache (60s, keyed by vendor) bounds spawn frequency for the long-lived
dashboard server; one-shot CLI invocations are unaffected.

### 5. JSON envelope for `ocr models list --json`

`source` must be accurate in machine output (AC #2); a bare array cannot
carry it. The command emits the full `ModelListResult` envelope; the
no-vendor case emits `{ vendor: null, source: null, models: [] }` mirroring
the HTTP route. Breaking for hypothetical external consumers; none exist
in-repo (verified: agents assets and dashboard do not shell `models list`).

### 6. Reason field naming

`nativeUnavailableReason?: string`, present iff `source === "bundled"`.
"Claude Code has no enumeration command" is a capability gap, not an error —
`nativeError` would invite red error styling for a normal state. For probe
failures the reason embeds exit detail and captured stderr (the probe now
pipes stderr instead of discarding it — the original regression's diagnostic,
`error: unknown option '--json'`, was thrown away by `stdio: ignore`).

### 7. Detection stays two-policy, contract-tested

`detectActiveVendor` (cli lib, PATH-order) and `AiCliService` (dashboard,
config-preference-aware) intentionally differ: preference policy belongs
where config lives. The drift class is closed structurally: detection
iterates the strategy table's vendors, and a dashboard contract test asserts
every registered adapter binary is a strategy-table vendor. The dropdown
passes an explicit vendor (`activeCli`) — `auto` is only a fallback.

### 8. E2E stub design (cross-platform, argv-strict)

Stub = one generated `*-stub.cjs` holding all logic (runtime artifact written
to a temp dir, not project source — CommonJS so the tripwire's `require` works
without ESM ceremony), fronted by a `#!/bin/sh` wrapper (POSIX) and a one-line
`.cmd` shim (`@node "%~dp0…" %*`, Windows). Both shims are
written on every OS so the Windows branch cannot rot unseen (PR CI is
ubuntu-only; the OS matrix runs on push to main). Strict argv dispatch:
`--version` → version, `models` → configured output, anything else → stderr +
exit 1 — so reintroducing `--json` fails the native-success e2e loudly.
Behaviors: native (LF and CRLF variants), garbage, exit-127 (absent), claude
tripwire. PATH is prepended via a case-insensitive env-key merge (Windows
`Path` vs `PATH`). The dashboard harness gains an opt-in `env` param.

## Migration

- Saved `.ocr/config.yaml` teams referencing removed bundled ids (e.g.
  `claude-opus-4-7`) keep working: pickers inject the unknown value as a
  "(custom)" option instead of rendering blank, and the id is passed through
  to the vendor CLI unchanged.
- `ocr models list --json` consumers (none known) switch from array to
  envelope; called out in the changelog via the commit body.
