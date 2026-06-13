# CLI Spec Delta — harden-process-spawning

## ADDED Requirements

### Requirement: Process Spawning Safety

All OCR process spawning SHALL go through the shared platform wrappers
(`execBinary`, `execBinaryAsync`, `spawnBinary`), which SHALL pass arguments
verbatim as argv on every platform — never through an interpreting shell —
while still resolving Windows `.cmd`/`.bat` shims. Free-text content (prompts,
requirements, reviewer descriptions) SHALL never be required to be
shell-safe: safety is the spawn layer's job.

#### Scenario: Arguments are not shell-interpreted on Windows

- **GIVEN** an argument containing cmd.exe metacharacters (e.g.
  `sonnet & calc.exe`)
- **WHEN** it is passed to a platform spawn wrapper on Windows
- **THEN** the child process SHALL receive the argument verbatim as a single
  argv entry
- **AND** no secondary command SHALL execute

#### Scenario: Windows .cmd shims still resolve

- **GIVEN** a vendor binary installed as an npm `.cmd` shim (e.g. `claude`,
  `opencode`, `ocr`)
- **WHEN** a platform wrapper spawns it by bare name on Windows
- **THEN** the shim SHALL resolve and execute without the caller opting into
  a shell

#### Scenario: Missing binaries are reported as ENOENT on every platform

- **WHEN** a wrapper spawns a binary that is not installed
- **THEN** the failure SHALL carry `code: "ENOENT"` on Windows and POSIX
  alike (not a shell's "not recognized" exit 1)

#### Scenario: execBinaryAsync failure shape is a stable contract

- **WHEN** an async exec fails
- **THEN** the rejection SHALL carry `{ code: number | "ENOENT", stderr,
  killed }`, with `killed: true` for timeout or output-limit kills
- **AND** this shape SHALL be pinned by platform-level contract tests against
  the real implementation

#### Scenario: No direct child_process usage outside the platform layer

- **WHEN** production code under `packages/*/src` spawns a process
- **THEN** it SHALL use the platform wrappers; a repo-invariant test SHALL
  fail on value-imports of `node:child_process` outside the platform package
  and test/e2e helpers

### Requirement: Vendor Session Id Binding Validation

`ocr session bind-vendor-id` SHALL validate the supplied vendor session id
against an argv-safety syntax class (`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/`)
before persisting it, because a bound id is sticky and later becomes spawn
argv (`--session <id>`). Per-vendor id grammars SHALL NOT be enforced —
vendors change formats silently, and the caller is an AI orchestrator
mid-workflow.

#### Scenario: Argv-unsafe session id is rejected at bind time

- **WHEN** the orchestrator runs `ocr session bind-vendor-id <agent>` with an
  id containing whitespace, quotes, or shell metacharacters
- **THEN** the command SHALL exit non-zero naming the offending character
- **AND** nothing SHALL be persisted (the bind remains available)

#### Scenario: Real vendor id shapes are accepted

- **WHEN** binding a Claude Code UUID or an OpenCode `ses_…` id
- **THEN** the bind SHALL succeed unchanged

## MODIFIED Requirements

### Requirement: `ocr models` Subcommand

The CLI SHALL provide an `ocr models list` subcommand that surfaces the model
identifiers the active vendor CLI is willing to accept, sourced from the
per-vendor model-listing strategy table in the CLI model-discovery library.
That table SHALL be the single source of truth for vendor model enumeration
across every surface (CLI command and dashboard route). Each vendor strategy
SHALL declare either a native enumeration probe (binary arguments plus an
output parser) or that native enumeration is unsupported with a
human-readable reason. Supported-vendor validation everywhere SHALL derive
from the strategy table, so adding a vendor is a single registration.

#### Scenario: Native enumeration via the vendor strategy's probe

- **GIVEN** the vendor strategy declares a native probe (e.g. OpenCode's
  `opencode models`, parsed as newline-delimited `provider/model` ids)
- **WHEN** the user runs `ocr models list` and the probe succeeds
- **THEN** the output SHALL include the vendor-native model identifiers
  returned by the underlying CLI
- **AND** the result SHALL report `source: "native"`

#### Scenario: Bundled fallback when the probe fails

- **GIVEN** the vendor strategy declares a native probe
- **WHEN** the probe fails (binary missing, non-zero exit, or unparseable
  output — including parseable output yielding zero model ids)
- **THEN** the output SHALL include the strategy's bundled known-good list
- **AND** the result SHALL report `source: "bundled"` with a
  `nativeUnavailableReason` describing the failure, including captured
  stderr where available

#### Scenario: Bundled fallback when the vendor declares no enumeration

- **GIVEN** the vendor strategy declares native enumeration unsupported
  (e.g. Claude Code, which has no model-listing command)
- **WHEN** the user runs `ocr models list`
- **THEN** no enumeration process SHALL be spawned
- **AND** the output SHALL include the strategy's bundled list with
  `source: "bundled"` and the strategy's curated `nativeUnavailableReason`
- **AND** the bundled list SHALL prefer vendor-native identifiers that do not
  go stale (e.g. Claude Code's documented `opus` / `sonnet` / `haiku`
  aliases) over dated model ids

#### Scenario: JSON output for programmatic consumption

- **GIVEN** the dashboard or workflow needs the model list
- **WHEN** `ocr models list --json` is invoked
- **THEN** the output SHALL be a single JSON envelope
  `{ vendor, source, models, nativeUnavailableReason? }` where `models` is an
  array of `{ id, displayName?, provider?, tags? }` records
- **AND** when no supported vendor is detected, the envelope SHALL be
  `{ vendor: null, source: null, models: [] }`

#### Scenario: Free-text model ids are gatekept only by the vendor-id syntax class

- **GIVEN** a user wants a model id that is not in the listed set
- **WHEN** any OCR surface accepts a model id
- **THEN** the listed models SHALL remain advisory only
- **AND** any string matching the vendor-id syntax class
  (`/^[A-Za-z0-9][A-Za-z0-9._/:@\[\]+-]{0,255}$/` — covering aliases like
  `sonnet[1m]`, dated ids, provider-prefixed and multi-slash ids, `:tag` and
  `@version` forms) SHALL be accepted and passed to the vendor CLI unchanged
- **AND** strings outside that class (whitespace, quotes, shell
  metacharacters — strings no vendor model id can be) SHALL be rejected at
  the configuration parse boundary with an error naming the offending
  character
- **AND** rejection SHALL NOT occur during model enumeration or at adapter
  spawn time
