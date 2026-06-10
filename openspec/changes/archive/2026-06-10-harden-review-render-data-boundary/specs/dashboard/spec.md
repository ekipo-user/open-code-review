## ADDED Requirements

### Requirement: Review Render Tree Degrades Gracefully on Unknown Values

The dashboard review-report render tree SHALL tolerate unrecognized enum values and missing optional metadata instead of throwing a render error that blanks the page. A lookup keyed by free-form parsed content (e.g. a discourse-block type, a verdict label, a reviewer icon) SHALL resolve to a neutral fallback rather than dereferencing an undefined config.

#### Scenario: Unknown discourse type renders a neutral block

- **WHEN** a review report contains a discourse section whose type is not one of the recognized values
- **THEN** the block SHALL render with a neutral style and the raw type as its label
- **AND** the review report SHALL NOT crash

#### Scenario: Missing reviewer icon renders a default glyph

- **WHEN** a reviewer is rendered whose `icon` is unset or not in the icon registry
- **THEN** a default glyph SHALL be shown rather than throwing

#### Scenario: Render errors are diagnosable

- **WHEN** a component within the dashboard error boundary throws during render
- **THEN** the error boundary SHALL log the React component stack so the failing subtree can be identified
