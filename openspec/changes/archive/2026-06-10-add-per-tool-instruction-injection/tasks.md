## 1. Config (source of truth)

- [x] 1.1 Add `InstructionFileTarget` + `instructionFiles?`/`vendorBinary?` to `AIToolConfig`
- [x] 1.2 Map native files: claude → CLAUDE.md, gemini → GEMINI.md, github-copilot → .github/copilot-instructions.md, windsurf → .windsurfrules (plaintext); codex/opencode/cursor/rest → AGENTS.md (omit)
- [x] 1.3 Add `vendorBinary` for the spawnable CLIs (claude, codex, gemini, opencode)

## 2. Injector

- [x] 2.1 Format-aware managed-block markers (markdown HTML comment vs plaintext line comment)
- [x] 2.2 `injectIntoProjectFiles(targetDir, selectedTools)` — always AGENTS.md + each selected tool's native file(s), de-duplicated, nested dirs created
- [x] 2.3 `plannedInstructionFiles(selectedTools)` for dry-run preview
- [x] 2.4 `findStaleInstructionFiles(targetDir, written)` for non-destructive stale detection
- [x] 2.5 `hasOcrInstructions` recognizes both marker formats

## 3. Call sites

- [x] 3.1 `init.ts` passes installed tools; prints written paths; warns on stale files
- [x] 3.2 `update.ts` passes `toolsToUpdate`; dry-run previews planned + stale; warns on stale
- [x] 3.3 Update `--no-inject` help text

## 4. Tests + verification

- [x] 4.1 Rewrite injector tests: per-tool cases, AGENTS.md-once, plaintext markers, nested dir, stale detection, content preservation
- [x] 4.2 `nx test cli` green; `nx build cli` green
- [x] 4.3 Manual smoke: `ocr init -t codex` (no CLAUDE.md), `-t claude,gemini,github-copilot`, `-t windsurf` (plaintext markers)
