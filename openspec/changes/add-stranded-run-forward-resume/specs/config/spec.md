## ADDED Requirements

### Requirement: Configurable Forward-Resume Cap and Lease

The system SHALL expose runtime configuration governing forward-resume bounds, mirroring the existing `runtime.*` key conventions (default, override, invalid-input handling). It SHALL provide `runtime.forward_resume_max_attempts` (the maximum number of forward-resume attempts per round before a run is closed non-success) defaulting to `2`, and `runtime.forward_resume_lease_seconds` (the single-writer resume-lease TTL) defaulting to a positive value sized to exceed the longest single phase. Consistent with the existing `runtime.*` readers, an out-of-domain value (non-integer, or attempts < 1) SHALL fall back to the safe built-in default with a stderr warning rather than be silently coerced to an unsafe value — a bad config never yields a `0`/negative cap and never blocks the CLI.

#### Scenario: Defaults apply when unset

- **WHEN** neither `runtime.forward_resume_max_attempts` nor `runtime.forward_resume_lease_seconds` is configured
- **THEN** the cap SHALL default to `2` and the lease TTL SHALL default to its built-in positive value

#### Scenario: Overrides are honored

- **WHEN** `runtime.forward_resume_max_attempts` is set to `3`
- **THEN** a round SHALL permit up to 3 forward-resume attempts before the non-success close

#### Scenario: Invalid input is rejected

- **WHEN** `runtime.forward_resume_max_attempts` is set to a non-integer or to a value < 1
- **THEN** configuration load SHALL fail with a clear error and SHALL NOT silently coerce the value
