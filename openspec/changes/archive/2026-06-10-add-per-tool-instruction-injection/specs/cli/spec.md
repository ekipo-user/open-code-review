## ADDED Requirements

### Requirement: Tool Instruction-File Mapping

The CLI SHALL maintain, as part of each tool's `AIToolConfig`, the tool's native instruction file(s) (`instructionFiles`) beyond the universal `AGENTS.md`. This mapping is the single source of truth that drives instruction injection, so that supporting a new tool is a configuration-only change. A tool that reads `AGENTS.md` natively SHALL declare no additional instruction file.

#### Scenario: Native file declared per tool

- **WHEN** the tool registry is consulted for injection
- **THEN** Claude Code maps to `CLAUDE.md`, Gemini CLI to `GEMINI.md`, GitHub Copilot to `.github/copilot-instructions.md`, and Windsurf to `.windsurfrules`
- **AND** Codex, OpenCode, and Cursor declare no additional file (they read `AGENTS.md`)

#### Scenario: Each instruction file declares its format

- **WHEN** an instruction file is a non-markdown file such as `.windsurfrules`
- **THEN** its mapping declares a `plaintext` format so the injector uses line-comment managed-block markers

## RENAMED Requirements

- FROM: `### Requirement: AGENTS.md Instruction Injection`
- TO: `### Requirement: Instruction File Injection`

## MODIFIED Requirements

### Requirement: Instruction File Injection

The CLI SHALL inject OCR instructions into project instruction files based on the selected tools, following the OpenSpec managed block pattern. The CLI SHALL always write the universal `AGENTS.md`, and additionally write each selected tool's native instruction file(s) as declared by `AIToolConfig.instructionFiles`. The CLI SHALL NOT write a tool-specific instruction file for a tool that was not selected — in particular, `CLAUDE.md` is written only when Claude Code is selected. A file shared by the selection (such as `AGENTS.md`) SHALL be written at most once.

#### Scenario: AGENTS.md is always written

- **GIVEN** user runs `ocr init` selecting any set of tools with injection enabled
- **WHEN** installation completes
- **THEN** a managed block `<!-- OCR:START -->...<!-- OCR:END -->` is appended to `AGENTS.md` (created if absent)

#### Scenario: Claude Code selected

- **GIVEN** user runs `ocr init` and Claude Code is among the selected tools
- **WHEN** installation completes
- **THEN** the managed block is also written to `CLAUDE.md`

#### Scenario: Non-Claude tool gets its native file, not CLAUDE.md

- **GIVEN** user runs `ocr init` selecting only Gemini CLI
- **WHEN** installation completes
- **THEN** the managed block is written to `GEMINI.md`
- **AND** no `CLAUDE.md` is created

#### Scenario: Tool that reads AGENTS.md natively gets no extra file

- **GIVEN** user runs `ocr init` selecting only Codex
- **WHEN** installation completes
- **THEN** only `AGENTS.md` receives the managed block and no tool-specific instruction file is created

#### Scenario: Non-markdown instruction file uses plaintext markers

- **GIVEN** user runs `ocr init` selecting Windsurf, whose native file is `.windsurfrules`
- **WHEN** installation completes
- **THEN** the managed block in `.windsurfrules` is delimited by line-comment markers (`# OCR:START` / `# OCR:END`) rather than HTML-comment markers

#### Scenario: Update existing instructions

- **GIVEN** an instruction file already contains an OCR managed block
- **WHEN** user runs `ocr init` or `ocr update` again
- **THEN** the existing managed block is replaced with the updated version
- **AND** content outside the managed block is preserved

#### Scenario: Stale instruction file is reported, not deleted

- **GIVEN** a `CLAUDE.md` contains an OCR managed block but Claude Code is no longer a configured tool
- **WHEN** user runs `ocr update`
- **THEN** the CLI warns that the file holds a stale OCR block
- **AND** the CLI does not delete or rewrite the file

#### Scenario: Skip injection with flag

- **GIVEN** user runs `ocr init --no-inject`
- **WHEN** installation completes
- **THEN** no instruction files are created or modified
