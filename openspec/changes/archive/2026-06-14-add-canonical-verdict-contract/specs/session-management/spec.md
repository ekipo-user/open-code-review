## MODIFIED Requirements

### Requirement: Round-Specific Artifacts

The system SHALL store discourse and synthesis outputs inside round directories, not at session root.

#### Scenario: Discourse output location
- **GIVEN** discourse phase completes for round 2
- **WHEN** discourse results are saved
- **THEN** the file SHALL be saved to `rounds/round-2/discourse.md`

#### Scenario: Final review output location
- **GIVEN** synthesis phase completes for round 2
- **WHEN** final review is saved
- **THEN** the file SHALL be saved to `rounds/round-2/final.md`

#### Scenario: Round metadata output location
- **GIVEN** the synthesis phase completes for round 1
- **WHEN** the orchestrator supplies structured round data to `ocr state complete-round` (via `--stdin` or `--file`)
- **THEN** the CLI SHALL write `rounds/round-1/round-meta.json` with validated structured review data
- **AND** the write SHALL occur regardless of which input source carried the payload, so a successful completion never leaves the round directory without its metadata artifact

#### Scenario: Shared context remains at root
- **GIVEN** a multi-round session exists
- **WHEN** context is examined
- **THEN** `discovered-standards.md`, `requirements.md`, and `context.md` SHALL remain at session root (shared across all rounds)
