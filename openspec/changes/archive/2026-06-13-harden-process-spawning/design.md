# Design — Process Spawning Hardening

Decisions reached by a four-seat architecture board (lead architect, lead AI
engineer, lead backend engineer, Fowler seat) against the verified call-site
map; full evidence in the PR.

## 1. The security boundary is the platform wrapper, not validation

`shell: isWindows` inside the wrappers is the class defect — any call-site
fix is an instance fix. cross-spawn (already in the lockfile at 7.0.6) owns
the two hard problems: Microsoft argv quoting + cmd metacharacter escaping,
and `.cmd` shim resolution — which is mandatory anyway because Node
(post-CVE-2024-27980) EINVAL-blocks spawning `.cmd` without a shell, so
"just drop shell:true" is not an option. Hand-rolled escaping (rejected)
re-derives cross-spawn's worst decade of Windows fixes; validation-only
(rejected) cannot cover prompts/requirements free text.

cross-spawn exposes only `spawn`/`spawn.sync`, so exec semantics are rebuilt
in the wrapper layer and pinned by contract tests written against the REAL
implementation (`node -e` fixtures), not consumer-side mocks:

- `execBinary`: cross-spawn.sync passthrough (timeout/encoding/input/maxBuffer
  are native to spawnSync); throws on `error` or non-zero `status` with
  `{ status, code, signal, stdout, stderr }` attached.
- `execBinaryAsync`: accumulate stdout/stderr; resolve `{stdout, stderr}`;
  reject ENOENT via cross-spawn's enoent shim (a Windows correctness
  improvement — was cmd.exe exit 1); reject non-zero with
  `{ code: <number>, stderr, killed }`; explicit setTimeout→kill for
  deterministic `killed: true`; reimplemented 1 MiB maxBuffer (spawn has
  none; dropping it silently would unbound memory on a chatty probe and
  orphan `describeProbeFailure`'s killed branch).
- `spawnBinary`: cross-spawn + `windowsHide: true`; no shell anywhere.
- `reapTree`/`taskkill` untouched (`taskkill` is an `.exe`).

Observable changes accepted: real-`.exe` children get true pids on Windows
(better supervision); Windows missing-binary becomes `ENOENT`; argv with
spaces/quotes now survives; anything depending on cmd.exe interpretation
breaks (audit found none in production).

## 2. Prompt delivery: stdin for both adapters, one shared helper

Verified empirically: `opencode run --format json` reads the prompt from
stdin and the NDJSON event stream (incl. top-level `sessionID` used by
session capture) is identical; the `--session … --continue` + stdin
combination must be smoke-verified pre-merge. Nothing in the
file-stdio wedge fix depends on stdin being `ignore` — it concerns fd 1/2
only; the detached+unref+stdin-pipe pattern is already proven in production
by the Claude adapter.

A shared `deliverPrompt(proc, prompt)` helper attaches a stdin `error`
handler BEFORE writing — the Claude adapter's existing bare
`proc.stdin?.write(prompt)` is an unhandled-EPIPE crash vector for the
dashboard process if the child dies before draining. Empty prompts are
rejected at spawn (OpenCode rejects empty messages; fail fast, not
mid-workflow).

Both adapters' spawn shapes get pinning tests (mock `spawnBinary` with a
PassThrough stdin): argv shape including the NEGATIVE invariant that no argv
element contains the prompt; stdin bytes + end(); stdio triple; resume argv;
model flag presence; detached/unref; EPIPE resilience. Today the spawn shape
of BOTH adapters is unpinned (the comment in opencode-adapter claiming
otherwise is stale — it pins only the resume display shape).

The opencode watchdog asymmetry (no terminal `result` sentinel; finalization
by `close` + hard deadline) is deliberate and must NOT be "harmonized" while
touching this code.

## 3. Validation: parse-boundary only, syntax class not vendor grammar

Rejection happens where strings ENTER (team-config parse — the single choke
point behind repo YAML, `--team` overrides, and the dashboard write path;
and `ocr session bind-vendor-id`, where a bad bind is sticky and later
becomes `--session` argv). Rejection must NOT happen in `models.ts`
enumeration ("listed models are convenience, never a gate"), in
`adapter.spawn()` (too late; wastes a run), or on prompts/requirements
(impossible by spec; covered by §1+§2).

Charset: `/^[A-Za-z0-9][A-Za-z0-9._/:@\[\]+-]{0,255}$/` for model ids —
admits claude aliases (`sonnet[1m]` requires the brackets), dated ids,
Bedrock `:`/ARN-ish ids, Vertex `@` versions, openrouter double-slash ids,
`:tag` suffixes, future gemini/codex shapes; excludes whitespace, quotes,
and cmd-active characters (`& | < > ^ % ! ( ) ; $ \``) that no vendor id
contains. Session ids: `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/` (claude
UUIDs, opencode `ses_…`); per-vendor format strictness deliberately
rejected — vendors drift formats silently and the caller is an AI agent
mid-workflow (false rejection ⇒ failed review). Errors name the offending
character (argv-safety framing, not model validity).

This narrows the spec's "any string the vendor CLI itself accepts SHALL
remain valid input" to the vendor-id syntax class — a deliberate spec
amendment in this change, not a silent reinterpretation. A single
`assertSafeModelId` lives in team-config (parse, don't validate-everywhere;
avoids regex lockstep duplication).

## 4. Recurrence prevention

- Raw-spawn migration: `review.ts --resume` (Windows-broken ENOENT today),
  `routes/team.ts` `ocr team set` (same), dashboard `ps` diagnostic.
- A repo-invariant test (no ESLint toolchain exists; a contract test is
  proportionate) scans `packages/*/src` for value-imports of
  `node:child_process` outside `shared/platform` and test/e2e helpers.
- CI: 3-OS unit matrix (see issue #41 in the same PR) is the net that makes
  this behavior change provable; Windows e2e dispatch re-validates the
  `.cmd` vendor stubs under cross-spawn before merge.

## Alternatives considered

- Hand-rolled cmd.exe escaping: rejected (reinvents cross-spawn, max risk).
- Validation-only with shell:true retained: rejected (cannot cover free
  text; leaves the class).
- Strict per-vendor session-id/model-id grammars: rejected (vendor drift +
  AI-orchestrator false-failure cost).
- ESLint no-restricted-imports: rejected for now (no lint toolchain in repo;
  a TS contract test achieves the invariant on every OS).
