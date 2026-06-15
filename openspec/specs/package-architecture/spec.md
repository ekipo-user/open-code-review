# package-architecture Specification

## Purpose

The package-architecture capability defines the workspace dependency graph:
applications (`cli`, `dashboard`) depend on shared libraries under
`packages/shared/*` and never on one another; shared libraries are source-only,
private, and inlined into each application's published bundle rather than
published to npm; and modules graduate from an application into a shared package
by cross-boundary consumption, not by an export-count threshold.

## Requirements
### Requirement: Applications depend on shared libraries, not on each other

Application packages (`cli`, `dashboard`) SHALL NOT depend on one another. Code
shared between applications SHALL live in dedicated library packages under
`packages/shared/*` that each application depends on directly.

#### Scenario: Dashboard no longer depends on the CLI application

- **WHEN** the dependency graph is inspected after this change
- **THEN** `packages/dashboard` has no dependency edge (runtime or dev) on
  `@open-code-review/cli`
- **AND** the persistence and configuration modules the dashboard uses are
  imported from `packages/shared/*` packages

#### Scenario: No application imports another application's internals

- **WHEN** any source file in an application package imports a workspace package
- **THEN** the imported package is either a `packages/shared/*` library or
  `@open-code-review/agents`
- **AND** it is never the `.` entry or a subpath of another application package

### Requirement: Shared layers are separated by concern

The extracted shared code SHALL be organized into packages aligned with their
architectural concern rather than bundled into a single package. The shared
packages and their inhabitants are:

- **`@open-code-review/platform`** — cross-platform/runtime utilities and the
  browser-safe domain helpers (the canonical verdict and round-count modules,
  process/liveness probes, spawn helpers). It is itself private and inlined (it
  is not a public-API exception; see `Shared packages are private and inlined,
  not published`).
- **`@open-code-review/persistence`** — the SQLite adapter (`db`), the
  workflow-state lifecycle (`state`), `test-support`, `vendor-resume`, and the
  `node:sqlite` runtime preconditions (`runtime-checks`).
- **`@open-code-review/config`** — `runtime-config`, `team-config`, and the
  model catalog (`models`).

The SQLite adapter (`db`) and the workflow-state lifecycle (`state`) SHALL reside
in the **same** package because their type modules are *currently* mutually
recursive and the connection-cache singleton requires a single module instance;
a future refactor that breaks the type cycle while preserving the single-cache
invariant MAY split them.

#### Scenario: db and state share one package without a cycle

- **WHEN** the shared packages are inspected
- **THEN** the SQLite adapter (`db`) and the workflow-state lifecycle (`state`)
  reside in the same `persistence` package as sibling source directories
- **AND** no package-level dependency cycle exists between persistence and config

#### Scenario: Configuration is a separate package

- **WHEN** the shared packages are inspected
- **THEN** runtime-config, team-config, and the model catalog reside in a `config`
  package distinct from `persistence`

#### Scenario: A single connection-cache instance under source consumption

- **WHEN** the persistence package's `db` module is consumed (by an app bundle or a
  test runner) and `test-support` drains the connection cache
- **THEN** `db` and `test-support` resolve to a single shared module instance, so
  one connection-cache singleton is used (no second private cache)
- **AND** this holds by source resolution alone, with no module marked external

### Requirement: Shared packages are private and inlined, not published

Shared library packages SHALL be `private: true`, declared by their consumers as a
`devDependency` with `workspace:*`, and inlined into each application's bundle at
build time. They SHALL NOT be published to npm and SHALL be excluded from the
release set, mirroring `@open-code-review/platform`.

#### Scenario: A shared package is excluded from release

- **WHEN** `nx release` selects projects to version and publish
- **THEN** no `packages/shared/*` package is included
- **AND** the fixed `cli`+`agents` release group is unchanged

#### Scenario: Shared code is inlined into the published CLI

- **WHEN** the `cli` package is bundled for publishing
- **THEN** the shared package code is inlined into the `cli` bundle
- **AND** the published `cli` does not list any `packages/shared/*` package as a
  runtime dependency

### Requirement: Browser-consumed shared code is exported on Node-free subpaths

Any shared module the dashboard **browser** bundle imports SHALL be exported on a
**Node-free subpath** — a package export condition whose transitive imports
include no `node:*` built-ins — so the browser bundle builds and runs without
Node polyfills or a stray `node:fs`/`node:child_process` crash. This is the
bundle-hygiene discipline established by the canonical verdict module
(`@open-code-review/platform/verdict`) and extended to the canonical round-count
module (`@open-code-review/platform/counts`). The package barrel (`.`) MAY pull
in Node built-ins; the browser SHALL import the Node-free subpath instead.

#### Scenario: A browser-imported helper has no Node built-ins on its subpath

- **WHEN** the dashboard client imports a shared domain helper (e.g. the verdict normalizer or the round-count derivation)
- **THEN** it imports it from a Node-free subpath export, not the package barrel
- **AND** the resulting browser bundle contains no `node:*` import from that helper

### Requirement: Extraction preserves observable behavior

Moving modules out of `cli` into shared packages SHALL NOT change observable
behavior, database schema, or configuration. Existing tests SHALL pass with import
paths re-pointed and no assertion changes.

#### Scenario: Suites stay green after extraction

- **WHEN** typecheck and the cli/dashboard unit suites and the cli-e2e +
  dashboard-api-e2e suites are run after the change
- **THEN** they pass with only import paths updated to the new packages
- **AND** no database migration is introduced by this change

### Requirement: Slices graduate to shared packages by cause, not by count

The rule governing when an internal module becomes a shared package SHALL be based
on cross-boundary consumption, not on a subpath-export count. A module graduates to
a `packages/shared/*` package when it is consumed across a package boundary (by
another application or an e2e package) rather than only by the owning application's
own code. The prior "extract at the 9th subpath" rule is removed.

#### Scenario: A cross-boundary module graduates

- **WHEN** a module in an application package is imported by a different application
  or an e2e package
- **THEN** it is a candidate to be moved into a `packages/shared/*` package
- **AND** the decision does not depend on how many subpath exports the owning
  package currently has

#### Scenario: An app-internal module stays put

- **WHEN** a module is imported only by its owning application's own code
- **THEN** it remains in that application package and does not earn a shared package

#### Scenario: An e2e package consuming an app module is a cross-boundary trigger

- **WHEN** a module in an application package is imported by that app's e2e package (e.g. `cli-e2e` importing a `cli` module)
- **THEN** it is a cross-boundary consumption and the module is a graduation candidate, the same as consumption by another application

#### Scenario: Graduation by necessity (single-instance) is also legitimate

- **WHEN** a module must share a single runtime instance with an already-shared module (e.g. `test-support` draining the `db` connection-cache singleton)
- **THEN** it MAY live in the shared package by *necessity* even if not itself cross-app consumed — co-residence required by a single-instance invariant is a valid cause

#### Scenario: A transitive dependency follows its consumer

- **WHEN** a module graduates to a shared package and depends on another app-internal module
- **THEN** that transitive dependency SHALL also move to a shared package (an app→shared dependency edge is forbidden in reverse: shared code SHALL NOT import app-internal code)

