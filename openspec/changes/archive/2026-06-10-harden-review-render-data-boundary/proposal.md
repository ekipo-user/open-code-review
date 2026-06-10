# Change: Harden the review render path against missing/unknown reviewer metadata

## Why

Opening a review report could crash the dashboard with `Cannot read properties of undefined (reading 'icon')` (issue #28). A `ReviewerMeta` entry whose `icon` was never set (older CLI, hand-edited `reviewers-meta.json`, or the `sync --stdin` path which never validated `icon`) reached an unguarded lookup. The crash is a class of bug — unvalidated data at rest plus unguarded enum/icon lookups at render — not a single line.

## What Changes

- Reviewer metadata SHALL always carry a non-empty `icon`. The CLI backfills a canonical default at the write boundary (`reviewers sync`) and the dashboard backfills again at the read boundary, so a missing icon can never reach the client.
- The default-icon mapping becomes a single shared source of truth (`@open-code-review/platform` `defaultIconFor`) used by the installer, the CLI validator, and the dashboard route.
- The review render tree SHALL degrade gracefully on unrecognized enum values (e.g. an unknown discourse-block type) instead of throwing, mirroring the tolerance the verdict banner already applies.

## Impact

- Affected specs: `reviewer-management`, `dashboard`
- Affected code: `packages/shared/platform/src/index.ts` (`defaultIconFor`, `BUILTIN_ICON_MAP`), `packages/cli/src/commands/reviewers.ts` (`validateReviewersMeta`), `packages/cli/src/lib/installer.ts` (`generateReviewersMeta`), `packages/dashboard/src/server/routes/reviewers.ts` (`readReviewersMeta`), `packages/dashboard/src/client/components/markdown/discourse-block.tsx`, `packages/dashboard/src/client/components/error-boundary.tsx`
