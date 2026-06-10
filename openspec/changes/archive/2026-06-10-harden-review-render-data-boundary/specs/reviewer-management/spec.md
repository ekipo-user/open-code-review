## ADDED Requirements

### Requirement: Reviewer Metadata Always Has a Renderable Icon

Every `ReviewerMeta` entry SHALL carry a non-empty `icon` string. The system SHALL guarantee this at both boundaries that produce or serve `reviewers-meta.json`, using a single shared default-icon authority (`defaultIconFor(id, tier)`): built-in reviewers resolve to their mapped glyph, and any other reviewer falls back to a tier-appropriate generic (`brain` for personas, `user` otherwise).

#### Scenario: Generated metadata carries an icon for every reviewer

- **WHEN** `reviewers-meta.json` is generated from reviewer markdown files
- **THEN** each `ReviewerMeta` row SHALL have a non-empty `icon` resolved from the shared default-icon authority

#### Scenario: Sync from structured JSON backfills a missing icon

- **WHEN** `ocr reviewers sync --stdin` receives a reviewer object whose `icon` is absent or an empty string
- **THEN** the persisted entry SHALL have `icon` backfilled from `defaultIconFor(id, tier)`
- **AND** the synced JSON written to disk SHALL contain the backfilled icon

#### Scenario: A non-string icon is rejected

- **WHEN** `ocr reviewers sync --stdin` receives a reviewer object whose `icon` is present but not a string
- **THEN** validation SHALL fail with an error identifying the offending reviewer

#### Scenario: Stale metadata is repaired when served

- **WHEN** the dashboard reads a `reviewers-meta.json` written by an older version whose reviewer omits `icon`
- **THEN** the served reviewer SHALL have `icon` backfilled before reaching the client, so no consumer observes an undefined icon
