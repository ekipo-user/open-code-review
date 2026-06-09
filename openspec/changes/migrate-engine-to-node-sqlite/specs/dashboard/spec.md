## MODIFIED Requirements

### Requirement: Zero Native Dependencies

The dashboard SHALL NOT require native compilation or a native-addon install
step. Its storage engine is the runtime's **built-in SQLite (`node:sqlite`)**,
and all other dependencies are pure JavaScript — so installation needs no
`node-gyp`, no platform-specific prebuilt binary, no install script, and no build
tools, on any platform. This requires **Node >= 22.5** (when `node:sqlite`
landed).

#### Scenario: Clean install on any platform

- **GIVEN** a fresh macOS, Linux, or Windows environment with Node.js >= 22.5
- **WHEN** the user installs `@open-code-review/cli` with any package manager (npm, pnpm including 10+, yarn)
- **THEN** installation completes without `node-gyp`, a platform-specific prebuild, an install script, or build tools
