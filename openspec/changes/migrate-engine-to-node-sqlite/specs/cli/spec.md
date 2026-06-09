## ADDED Requirements

### Requirement: Built-in SQLite Engine

OCR's SQLite engine SHALL be **Node's built-in `node:sqlite`** — not a native dependency. The CLI SHALL ship
with **no native module, no prebuilt binary, and no dependency install script**, so installation produces a
working engine under any package manager (npm, pnpm including 10+, yarn) on every supported platform. The CLI
SHALL require **Node >= 22.5** (when `node:sqlite` became available) and SHALL fail with a clear, actionable
message — never an opaque module-load crash — on an older runtime.

#### Scenario: Installs with no native build under any package manager

- **WHEN** the CLI is installed with npm, pnpm (incl. 10+ with build scripts blocked), or yarn
- **THEN** no native module is compiled and no install script runs
- **AND** `ocr doctor` reports the storage engine loaded and on-disk DB commands succeed

#### Scenario: WAL + cross-process concurrency is preserved

- **GIVEN** the CLI and the long-lived dashboard open the same on-disk `ocr.db`
- **WHEN** they write concurrently
- **THEN** the engine SHALL use WAL with `BEGIN IMMEDIATE` write-lock acquisition and a bounded SQLITE_BUSY
  retry, so concurrent writers serialize cleanly and no write is lost

#### Scenario: Too-old Node fails with a clear guard, not a crash

- **GIVEN** a runtime older than Node 22.5
- **WHEN** any `ocr` command runs
- **THEN** the CLI SHALL print a message stating it requires Node >= 22.5 and how to upgrade, and exit non-zero
- **AND** it SHALL NOT emit a `Cannot find module 'node:sqlite'` stack trace

#### Scenario: The experimental warning does not pollute output

- **WHEN** the engine loads
- **THEN** `node:sqlite`'s one-line experimental warning SHALL be suppressed, leaving the machine-readable
  stdout contract (e.g. `ocr state status --json`) untouched

#### Scenario: The published tarball is install-verified before release

- **WHEN** a release is prepared
- **THEN** CI SHALL install the published cli tarball under **both npm and pnpm 10 (default, scripts blocked)**
  on supported Node versions, asserting the engine loads and a real DB command succeeds, **before** the release
  is promoted to the `latest` dist-tag
