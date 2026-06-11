# Dashboard Spec Delta — update-vendor-model-enumeration

## MODIFIED Requirements

### Requirement: Team Composition Panel

The dashboard SHALL provide a Team Composition Panel in the New Review flow
that lets the user compose a per-run team — count, persona selection, and
per-instance models — without editing YAML. Model dropdowns across all
dashboard surfaces (team composition panel, reviewer dialog, default team
section) SHALL be populated from `GET /api/team/models`, which is backed by
the shared CLI model-discovery library — adapters SHALL NOT carry their own
model-enumeration logic.

#### Scenario: Panel reads the resolved team

- **GIVEN** the user opens "New Review" from the Command Center
- **WHEN** the Team Composition Panel mounts
- **THEN** it SHALL request `GET /api/team/resolved` and populate persona rows
  from the result
- **AND** it SHALL request `GET /api/team/models?vendor=<activeCli>` to
  populate model dropdowns

#### Scenario: Same-model and per-reviewer modes per persona row

- **GIVEN** a persona row with count > 1
- **WHEN** the user toggles between "Same model" and "Per reviewer" mode
- **THEN** in "Same model" mode, one model dropdown SHALL apply to all
  instances of that persona
- **AND** in "Per reviewer" mode, each instance row SHALL display its own
  model dropdown

#### Scenario: Adding and removing reviewers

- **GIVEN** the panel is open
- **WHEN** the user adds a reviewer not currently in the team
- **THEN** a new row SHALL appear with count 1 and `(default)` model selected
- **AND** the user SHALL be able to remove rows by setting count to 0 or via
  an explicit remove control

#### Scenario: Save as default checkbox is opt-in

- **GIVEN** the user has customized the team for this run
- **WHEN** the user clicks Run with the "Save as default for this workspace"
  checkbox unchecked
- **THEN** the override SHALL be passed to `ocr review` as a session-only
  `--team` argument
- **AND** `.ocr/config.yaml` SHALL NOT be modified

#### Scenario: Save as default persists to config

- **GIVEN** the user has customized the team for this run
- **WHEN** the user clicks Run with the "Save as default for this workspace"
  checkbox checked
- **THEN** the dashboard SHALL invoke `ocr team set --stdin` with the new team
- **AND** SHALL then invoke `ocr review` without a session override

#### Scenario: Free-text model entry is always available

- **GIVEN** the model dropdown is populated (natively or from the bundled
  fallback)
- **WHEN** the user opens a model picker
- **THEN** the picker SHALL offer a "Custom…" entry that accepts free-text
  model id input
- **AND** when the model list is empty, the picker SHALL degrade entirely to
  a free-text input
- **AND** any model id accepted by the underlying CLI SHALL be valid input

#### Scenario: Bundled fallback source is disclosed

- **GIVEN** `GET /api/team/models` reports `source: "bundled"`
- **WHEN** a model-picker surface renders
- **THEN** the surface SHALL display a hint that the list is a bundled
  fallback (with the reported `nativeUnavailableReason`), not the vendor's
  live model inventory

#### Scenario: Unknown saved model ids render as custom options

- **GIVEN** a saved team references a model id not present in the current
  model list
- **WHEN** a model picker renders with that value
- **THEN** the picker SHALL render the saved id as a selectable "(custom)"
  option — it SHALL NOT render blank or fall back to the `(default)` label
- **AND** the saved id SHALL be passed through to the vendor CLI unchanged

#### Scenario: Host without per-task model support disables per-reviewer mode

- **GIVEN** the active adapter reports `supportsPerTaskModel = false`
- **WHEN** the panel is rendered
- **THEN** the "Per reviewer" mode toggle SHALL be disabled with an
  explanatory tooltip
- **AND** all reviewers in a run SHALL be expected to share the same parent
  model

### Requirement: New Server Routes

The dashboard server SHALL expose new HTTP routes that back the team panel,
agent-session liveness, "Continue here", and "Pick up in terminal" features.

#### Scenario: Team resolution endpoint

- **GIVEN** the dashboard team panel is loading
- **WHEN** the client calls `GET /api/team/resolved`
- **THEN** the server SHALL invoke `ocr team resolve --json` and return the
  resulting `ReviewerInstance[]`

#### Scenario: Team default persistence endpoint

- **GIVEN** the user has chosen "Save as default" with a customized team
- **WHEN** the client calls `POST /api/team/default` with
  `{ team: ReviewerInstance[] }`
- **THEN** the server SHALL invoke `ocr team set --stdin` with the supplied
  team and return success or a validation error

#### Scenario: Model listing endpoint

- **GIVEN** a dashboard surface needs the model list for a vendor
- **WHEN** the client calls `GET /api/team/models?vendor=<vendor>`
- **THEN** the server SHALL return the CLI model-discovery library's envelope
  `{ vendor, source, models, nativeUnavailableReason? }` without blocking the
  event loop on synchronous process spawns
- **AND** vendor validation SHALL derive from the strategy table's supported
  vendors (unknown vendors → 400)
- **AND** `vendor=auto` (or omitted) SHALL resolve via detection and return
  `{ vendor: null, source: null, models: [] }` when no vendor is installed

#### Scenario: Agent-session listing endpoint

- **GIVEN** the dashboard liveness header is loading for a session
- **WHEN** the client calls `GET /api/agent-sessions?workflow=<id>`
- **THEN** the server SHALL return the agent-session rows for that workflow

#### Scenario: In-dashboard continue endpoint

- **GIVEN** the user clicks "Continue here"
- **WHEN** the client calls `POST /api/sessions/:id/continue`
- **THEN** the server SHALL invoke `ocr review --resume <id>` via the existing
  command runner and emit live progress over Socket.IO

#### Scenario: Terminal handoff endpoint

- **GIVEN** the user opens the handoff panel for a session
- **WHEN** the client calls `GET /api/sessions/:id/handoff`
- **THEN** the server SHALL return a payload `{ vendor, vendorSessionId,
  projectDir, hostBinaryAvailable, ocrCommand, vendorCommand }`
- **AND** the two command strings SHALL be fully built server-side
