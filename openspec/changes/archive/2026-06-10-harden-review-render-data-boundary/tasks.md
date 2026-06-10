## 1. Shared default-icon authority

- [x] 1.1 Move `BUILTIN_ICON_MAP` + add `defaultIconFor(id, tier)` to `@open-code-review/platform`
- [x] 1.2 Refactor `installer.ts` `generateReviewersMeta` to call `defaultIconFor`
- [x] 1.3 Unit-test `defaultIconFor` (built-in, unknown persona → brain, unknown other → user, never empty)

## 2. Write boundary (CLI)

- [x] 2.1 `validateReviewersMeta` rejects a non-string `icon`, backfills a missing/empty `icon` with `defaultIconFor`
- [x] 2.2 Tests: explicit icon preserved, missing/empty backfilled, non-string rejected

## 3. Read boundary (dashboard)

- [x] 3.1 `readReviewersMeta` backfills `icon` per row so the API never emits an icon-less reviewer
- [x] 3.2 Loose input type (`icon?: string`) at the parse boundary; client-facing `ReviewerMeta.icon` stays required
- [x] 3.3 Test: missing icon → backfilled in response; explicit icon preserved

## 4. Render-time defense

- [x] 4.1 `discourse-block.tsx` falls back to a neutral config for unknown types (no `config.icon` on `undefined`)
- [x] 4.2 Add `file-text` glyph to the dashboard icon registry (docs-writer was unmapped)
- [x] 4.3 Defensive guard in `liveness-header.tsx`
- [x] 4.4 `error-boundary.tsx` logs the component stack via `componentDidCatch`
- [x] 4.5 Test: unknown discourse type resolves to a neutral config instead of throwing

## 5. Verification

- [x] 5.1 `nx test platform cli dashboard` green
- [x] 5.2 `nx build cli dashboard` green
