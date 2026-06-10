# Change: Inject the right instruction file per selected AI tool

## Why

`ocr init` unconditionally wrote both `AGENTS.md` and `CLAUDE.md` regardless of which tools were selected (issue #28). A Gemini- or Codex-only project got a stray `CLAUDE.md` that its host never reads, and tools whose native file is neither `AGENTS.md` nor `CLAUDE.md` (Gemini → `GEMINI.md`, GitHub Copilot → `.github/copilot-instructions.md`, Windsurf → `.windsurfrules`) never got OCR instructions where their host actually looks.

## What Changes

- **BREAKING (behavioral):** injection is now tool-selection-aware. The CLI always writes the universal `AGENTS.md`, plus each selected tool's native instruction file(s). `CLAUDE.md` is written only when Claude Code is among the selected tools.
- `AIToolConfig` gains an `instructionFiles` mapping (and an optional `vendorBinary`) as the single source of truth for a tool's native instruction file(s); adding a new tool is a config-only change.
- Non-markdown instruction files (`.windsurfrules`) use line-comment managed-block markers instead of HTML comments.
- `ocr update` warns (non-destructively) about stale native files that still carry an OCR block but belong to no configured tool; it never deletes user-owned files. `--dry-run` previews the exact target set.

## Impact

- Affected specs: `cli`, `config`
- Affected code: `packages/cli/src/lib/config.ts`, `packages/cli/src/lib/injector.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/update.ts`, `packages/cli/src/lib/__tests__/injector.test.ts`
