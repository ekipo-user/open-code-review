## ADDED Requirements

### Requirement: Configurable Forward-Resume Cap and Lease

The system SHALL expose runtime configuration governing forward-resume bounds, mirroring the existing `runtime.*` key conventions (default, override, invalid-input rejection). It SHALL provide `runtime.forward_resume_max_attempts` (the maximum number of forward-resume attempts per round before a run is closed non-success) defaulting to `2`, and `runtime.forward_resume_lease_seconds` (the single-writer resume-lease TTL) defaulting to a small positive value. An out-of-domain value (non-integer, or attempts < 1) SHALL be rejected at load with a clear error rather than silently coerced.

#### Scenario: Defaults apply when unset

- **WHEN** neither `runtime.forward_resume_max_attempts` nor `runtime.forward_resume_lease_seconds` is configured
- **THEN** the cap SHALL default to `2` and the lease TTL SHALL default to its built-in positive value

#### Scenario: Overrides are honored

- **WHEN** `runtime.forward_resume_max_attempts` is set to `3`
- **THEN** a round SHALL permit up to 3 forward-resume attempts before the non-success close

#### Scenario: Invalid input is rejected

- **WHEN** `runtime.forward_resume_max_attempts` is set to a non-integer or to a value < 1
- **THEN** configuration load SHALL fail with a clear error and SHALL NOT silently coerce the value
