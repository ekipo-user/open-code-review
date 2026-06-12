# Tasks — harden-process-spawning

(Ships in one PR with the issue-#41 Windows test fixes; #41 items listed
where they gate this change.)

## 1. Prerequisites from issue #41 (same PR, earlier commits)

- [ ] 1.1 Platform process tests stop depending on `sleep`/cmd.exe accidents
      (node `.cjs` fixtures + pid handshake; per-platform contract
      assertions for `descendantPids`/`reapTree`)
- [ ] 1.2 Errno classifier extracted (platform) and shared by
      `isProcessAlive`/`defaultIsAlive`; deterministic EPERM/ESRCH tests
- [ ] 1.3 Dashboard capture tests close DB handles before teardown
      (shared temp-workspace helper; throwing retried rmSync)
- [ ] 1.4 CI: 3-OS unit coverage added (direct-vitest loop on the matrix
      legs for diagnosability)

## 2. Platform wrappers (cross-spawn)

- [ ] 2.1 `refactor(platform)`: extract spawn wrappers into `spawn.ts`
      (barrel re-export from index; behavior-preserving)
- [ ] 2.2 Contract tests FIRST against the real implementation:
      execBinary throws on non-zero/ENOENT with status+stderr; execBinaryAsync
      rejects `{code: number|"ENOENT", stderr, killed}`; timeout sets
      killed; maxBuffer overflow kills + rejects; input passthrough
- [ ] 2.3 Re-implement wrappers on cross-spawn / cross-spawn.sync per
      design §1; add `cross-spawn` dep (+ types) to shared/platform
- [ ] 2.4 Update stale comments tying `.cmd` stubs/shims to `shell: true`
      (vendor-stubs helpers, wrapper docs)

## 3. Prompt delivery

- [ ] 3.1 Shared `deliverPrompt` helper with stdin error guard; claude
      adapter migrated onto it (fixes latent EPIPE crash)
- [ ] 3.2 OpenCode adapter: prompt via stdin (argv positional removed),
      `buildFileStdio` stdin `'pipe'`, empty-prompt guard, stale comments
      rewritten
- [ ] 3.3 Pinning suite for BOTH adapters' spawn shapes (argv incl.
      prompt-not-in-argv negative invariant, stdin bytes, stdio triple,
      resume argv, model flag, detached/unref, EPIPE resilience)
- [ ] 3.4 Live smoke: `opencode run --format json --session <id> --continue`
      with stdin prompt processes the new turn and emits `sessionID` events

## 4. Validation (defense in depth)

- [ ] 4.1 `assertSafeModelId` in team-config parsing (single choke point);
      error names the offending character
- [ ] 4.2 Session-id charset validation at `ocr session bind-vendor-id`
- [ ] 4.3 Unit tests: every known vendor id shape admitted (incl.
      `sonnet[1m]`, openrouter double-slash, Bedrock/Vertex forms);
      metacharacter strings rejected with pointed errors

## 5. Raw call-site migration + invariant

- [ ] 5.1 `review.ts --resume` → `spawnBinary` (fixes Windows ENOENT)
- [ ] 5.2 `routes/team.ts` `ocr team set --stdin` → `execBinary` with input
- [ ] 5.3 Dashboard `ps` diagnostic → `execBinary`
- [ ] 5.4 Repo-invariant test: no value-import of `node:child_process`
      outside shared/platform + test/e2e helpers

## 6. Verification

- [ ] 6.1 `pnpm nx run-many -t typecheck build test -p platform cli dashboard`
- [ ] 6.2 `pnpm nx e2e cli-e2e` + `pnpm nx e2e dashboard-api-e2e`
- [ ] 6.3 Windows dispatch (targets=all) green — units AND e2e (`.cmd`
      stubs under cross-spawn); macOS dispatch green
- [ ] 6.4 `openspec validate harden-process-spawning --strict`
