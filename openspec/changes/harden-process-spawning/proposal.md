# Harden Process Spawning (Windows argv safety + prompt delivery)

## Why

Issue #43: the platform spawn wrappers (`execBinary` / `execBinaryAsync` /
`spawnBinary` in `packages/shared/platform`) pass `shell: true` on Windows so
npm `.cmd` shims resolve. Node does not escape arguments under `shell: true`,
so every argv string becomes part of one cmd.exe command line. Mapping the
call sites shows attacker-influenced strings reaching argv today:

- `--model <value>` in both AI-CLI adapters — sourced from `.ocr/config.yaml`
  team config (a **cloned repo's config is untrusted input**), the dashboard's
  free-text model entry, and the CLI `--team` override. A malicious model id
  like `sonnet & evil.exe` in a cloned team config is a realistic
  config-to-RCE vector on Windows.
- **The entire prompt**, passed as a positional argv by the OpenCode adapter
  (`['run', prompt, …]`) — embeds user input, requirements, and review/code
  content. Beyond injection, cmd.exe's ~8191-character command-line limit
  means large workflow prompts already break OpenCode workflow mode on
  Windows, and the prompt is visible to any process listing.
- `--session <id>` from `ocr session bind-vendor-id` (orchestrator-writable),
  and dashboard-sourced `--team`/`--reviewer`/`--requirements` free text
  forwarded to `ocr` by the command-runner.

Two raw (non-wrapper) call sites are additionally broken on Windows outright:
`ocr review --resume` (`packages/cli/src/commands/review.ts`) and the
dashboard's `ocr team set` invocation (`routes/team.ts`) spawn `.cmd`-shimmed
binaries without any shim resolution → ENOENT.

## What Changes

- **Platform wrappers adopt `cross-spawn` semantics** (the npm-ecosystem
  standard, already in the lockfile): correct Windows argument escaping and
  `.cmd`/`.bat` shim resolution **without** `shell: true`, on every wrapper.
  Public contracts preserved and now pinned by platform-level contract tests:
  `execBinary` throws on failure (execFileSync-style, `status`/`code`/`stderr`
  attached); `execBinaryAsync` rejects with `{ code: number | "ENOENT",
  stderr, killed }` and reimplements execFile's timeout-kill and 1 MiB
  `maxBuffer` semantics. Windows missing-binary now correctly surfaces
  `ENOENT` (previously cmd.exe exit 1 — `describeProbeFailure`'s "not
  installed" branch could never fire on Windows).
- **OpenCode prompt moves from positional argv to stdin**, mirroring the
  Claude adapter (verified: `opencode run` reads the message from stdin and
  emits the identical JSON event stream, including with
  `--session … --continue`). Prompt delivery is extracted into one shared
  helper with an `error`-event guard — the Claude adapter's existing bare
  `stdin.write` is an unhandled-EPIPE crash vector. Both adapters' spawn
  shapes (argv + stdin delivery) gain pinning tests; today neither is pinned.
- **Parse-boundary argv-safety validation** (defense in depth, NOT the
  security mechanism): model ids are validated where they enter the system
  (team-config parsing, which backs the YAML config, `--team` overrides, and
  the dashboard write path) against a syntax class that admits every known
  vendor id shape — `/^[A-Za-z0-9][A-Za-z0-9._/:@\[\]+-]{0,255}$/` (claude
  aliases incl. `sonnet[1m]`, dated ids, Bedrock ARN-ish ids, Vertex `@`
  versions, multi-slash openrouter ids, `:tag` suffixes) — and rejects only
  strings no vendor model id can be (whitespace, quotes, cmd metacharacters).
  Vendor session ids get the same treatment at `ocr session bind-vendor-id`
  (a charset without `/`), since a bind is sticky and later becomes argv.
- **Raw call sites migrate to the wrappers** (`review.ts --resume`,
  `routes/team.ts`, the dashboard's `ps` diagnostic), and a repo-invariant
  test forbids value-imports of `node:child_process` outside
  `shared/platform` and test helpers, so the class cannot quietly return.

## Impact

- Affected specs: `cli` (free-text model entry scenario narrowed to the
  vendor-id syntax class; new Process Spawning Safety requirement;
  `bind-vendor-id` validation), `dashboard` (adapter prompt delivery via
  stdin).
- Affected packages: `shared/platform` (new runtime dep `cross-spawn`),
  `cli` (team-config validation, session bind validation, review --resume),
  `dashboard` (adapters, helpers, routes/team), CI (Windows e2e
  re-validation required — `.cmd` vendor stubs must resolve under
  cross-spawn).
- Risk posture: A (wrapper semantics) + B (prompt off argv) are the security
  fix; C (validation) is defense-in-depth/UX. The narrowed free-text scenario
  is a deliberate, documented contract change.
- Ships together with the issue-#41 Windows test fixes (same PR): the new
  3-OS unit coverage is the safety net that proves this behavior change, and
  the #41 fixture fixes (`sleep` → node fixtures) are prerequisites for
  removing `shell: true`.
