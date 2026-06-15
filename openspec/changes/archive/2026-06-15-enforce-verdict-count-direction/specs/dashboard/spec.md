## ADDED Requirements

### Requirement: Legacy Verdict/Finding Mismatch Hint

The dashboard SHALL surface a non-destructive **render-time mismatch hint** for
any round whose recorded `verdict` disagrees in direction with its deduplicated
blocker count (`resolveRoundCounts().blockerCount`) — the legacy shape the
shipped `verdict ↔ blocker-count` CLI gate now prevents for new rows but cannot
retroactively fix for already-stored rows. The hint SHALL be computed at read
time from the existing row; it SHALL NOT rewrite the stored verdict or counts,
and it SHALL NOT block rendering. New rows, gated by the CLI directional check,
never trigger it.

#### Scenario: APPROVE beside a non-zero blocker count shows a mismatch hint

- **GIVEN** a legacy round row recorded as `APPROVE` whose deduplicated blocker count is ≥ 1
- **WHEN** the round is rendered
- **THEN** the dashboard SHALL display a "verdict/finding mismatch" hint alongside the verdict badge
- **AND** it SHALL NOT rewrite the stored verdict or counts

#### Scenario: A consistent round shows no hint

- **GIVEN** a round whose verdict and deduplicated blocker count agree in direction
- **WHEN** the round is rendered
- **THEN** no mismatch hint SHALL be shown
