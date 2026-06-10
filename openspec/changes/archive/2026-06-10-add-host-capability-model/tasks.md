## 1. Host-neutral skill prose (source of truth in packages/agents/)

- [x] 1.1 `SKILL.md` — Phase-4 instantiation is host-neutral with a sequential fallback; Claude Code is an example, not the assumed host
- [x] 1.2 `workflow.md` Phase 4 — add the spawn-vs-sequential strategy step; `--vendor $HOST_VENDOR` instead of literal `claude`; rename "Spawn Reviewers" → "Run Reviewers"
- [x] 1.3 `reviewer-task.md` — wording covers spawned or sequentially-run reviewers
- [x] 1.4 Sync to `.ocr/` via `nx run cli:update`

## 2. Adapter capability flag

- [x] 2.1 Add `supportsSubagentSpawn` to `AiCliAdapter`
- [x] 2.2 Set on Claude Code (`true`) and OpenCode (`true`)
- [x] 2.3 Update the adapter test stub to the new contract

## 3. Host capability source of truth + query command

- [x] 3.1 Add `HostCapabilities` + `hostCapabilities` to `AIToolConfig`, with `DEFAULT_HOST_CAPABILITIES` and `getHostCapabilities`
- [x] 3.2 Declare capabilities for claude/opencode/gemini/codex; editors default conservatively
- [x] 3.3 Add `ocr host capabilities [--tool <id>] [--json]` command and register it
- [x] 3.4 Reference `ocr host capabilities` from the skill Phase-4 prose
- [x] 3.5 Tests: per-tool capability resolution, complete-descriptor guard, instruction-file mapping

## 4. Verification

- [x] 4.1 `nx test cli dashboard` green; `nx build cli dashboard` green
- [x] 4.2 Smoke: `ocr host capabilities --json` lists all tools; `--tool gemini` → sequential
- [x] 4.3 No Claude-only spawn assumption remains in the skill Phase-4 prose
