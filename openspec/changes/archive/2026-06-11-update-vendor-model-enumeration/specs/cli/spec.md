# CLI Spec Delta — update-vendor-model-enumeration

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

#### Scenario: Free-text model ids are never gatekept

- **GIVEN** a user wants a model id that is not in the listed set
- **WHEN** any OCR surface accepts a model id
- **THEN** the listed models SHALL be advisory only — any string the vendor
  CLI itself accepts SHALL remain valid input
