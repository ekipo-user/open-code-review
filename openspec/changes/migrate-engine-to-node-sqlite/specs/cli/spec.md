## ADDED Requirements

### Requirement: Engine Distribution and Runtime Floor

The CLI SHALL install and run with a working SQLite engine under any package
manager (npm, pnpm including 10+, yarn) with **no native build step and no
install script**, and SHALL fail clearly on an unsupported runtime rather than
crashing. (The engine itself — Node's built-in `node:sqlite` — is specified
under the `sqlite-state` capability; this requirement covers distribution and
the runtime floor.)

#### Scenario: Installs with no native build under any package manager

- **WHEN** the CLI is installed with npm, pnpm (incl. 10+ with build scripts blocked), or yarn
- **THEN** no native module is compiled and no install script runs
- **AND** `ocr doctor` reports the storage engine loaded and on-disk DB commands succeed

#### Scenario: Too-old Node fails fast with a clear message

- **GIVEN** a runtime older than Node 22.5
- **WHEN** any `ocr` command runs
- **THEN** the CLI SHALL print a message stating it requires Node >= 22.5 and how to upgrade, and exit non-zero
- **AND** it SHALL NOT emit a `Cannot find module 'node:sqlite'` stack trace

#### Scenario: The experimental warning does not pollute output

- **WHEN** the engine loads
- **THEN** `node:sqlite`'s one-line experimental warning SHALL be suppressed, leaving the machine-readable stdout contract (e.g. `ocr state status --json`) untouched

#### Scenario: The published tarball is install-verified before release

- **WHEN** a release is prepared
- **THEN** CI SHALL install the **published cli tarball** under **both npm and pnpm 10 (default, scripts blocked)** on supported Node versions, asserting the engine loads (including an on-disk WAL transaction round-trip via `ocr doctor --probe-write`) and a real DB command succeeds, **before** promoting the release to the `latest` dist-tag

## MODIFIED Requirements

### Requirement: Zero Dashboard Startup Cost

The dashboard code SHALL NOT be loaded unless the user runs `ocr dashboard`. Commands like `ocr init`, `ocr progress`, and `ocr state` MUST remain fast.

#### Scenario: Dynamic import only on dashboard command

- **GIVEN** user runs any CLI command other than `ocr dashboard`
- **WHEN** the CLI process starts
- **THEN** the dashboard server module (`dist/dashboard/server.js`) SHALL NOT be imported or loaded

#### Scenario: Dashboard dependencies isolated

- **GIVEN** the dashboard adds significant dependencies (React, Socket.IO, Mermaid)
- **WHEN** user runs `ocr init` or `ocr progress`
- **THEN** none of these dependencies are loaded
- **AND** CLI startup time is unaffected
