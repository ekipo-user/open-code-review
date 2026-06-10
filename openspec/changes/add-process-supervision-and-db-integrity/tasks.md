## 1. Process supervision (WS-A)

- [x] 1.1 `reapTree` / `descendantPids` / `isProcessAlive` in `@open-code-review/platform` (POSIX tree-walk + Windows `taskkill /T`)
- [x] 1.2 `result` event in the claude parser + `NormalizedEvent` union
- [x] 1.3 First-wins idempotent `finishExecution` (CAS on `finished_at IS NULL`, clears watchdog)
- [x] 1.4 Per-execution watchdog: reap-on-result-grace + hard-deadline (exit code -5)
- [x] 1.5 Cancel reaps the whole tree via `reapTree`; detached spawns `unref`'d
- [x] 1.6 Platform tests for `isProcessAlive` / `descendantPids` / `reapTree`

## 2. Liveness heartbeat (WS-B)

- [x] 2.1 Parent-row heartbeat bumped on stdout activity (throttled) + supervisor tick

## 3. DB integrity (WS-D)

- [x] 3.1 `upsertMarkdownArtifact` → explicit UPDATE-or-INSERT (no more `INSERT OR REPLACE` append)
- [x] 3.2 Migration v14: collapse duplicates + NULL-safe unique index
- [x] 3.3 Migration tests (dedup + index enforcement)

## 4. Orphan files + singleton (WS-E partial, WS-F)

- [x] 4.1 Dashboard startup reaps `ocr.db.<pid>.tmp` orphans (PID + age guarded)
- [x] 4.2 Single-instance: reap prior OCR-dashboard tree + take over (no port-increment coexistence)

## 5. Follow-ups (tracked; not in this change)

- [ ] 5.1 `reconcileWorkflowOnExit` — auto-close `active`+`complete` sessions via guarded `stateClose` (WS-C)
- [ ] 5.2 `ocr db doctor/prune/vacuum` operator commands incl. FK-orphan sweep (WS-E)
- [ ] 5.3 File-stdio redirect as belt-and-suspenders for pipe inheritance (WS-A hardening)
