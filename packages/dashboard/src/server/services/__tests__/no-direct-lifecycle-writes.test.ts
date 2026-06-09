/**
 * Architecture invariant: single-writer lifecycle (review Should Fix 4).
 *
 * The dashboard server must NOT perform ad-hoc session-lifecycle writes.
 * Every lifecycle close routes through `commitReasonClose` (the single
 * writer), so the event-sourced `session_completeness` projection stays
 * authoritative and the dashboard can never disagree with the agent.
 *
 * This is a cheap static guard: it scans the server source for the three
 * forbidden write shapes and fails CI if a future change reintroduces a
 * direct lifecycle write — catching the regression at build time rather
 * than as a subtle "completed too soon" outcome bug in production.
 *
 * Deliberately tolerant of the benign projection-sync write
 * `UPDATE sessions SET current_round = ?, current_map_run = ?` (round/run
 * pointer sync, not a status change): the `UPDATE sessions SET status`
 * regex is anchored on `status` so it does not match.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// __tests__ → services → server
const serverRoot = dirname(dirname(here))

/** Forbidden ad-hoc lifecycle write shapes — all closes go through commitReasonClose. */
const FORBIDDEN_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: 'INSERT INTO sessions', regex: /INSERT\s+INTO\s+sessions\b/i },
  {
    label: 'INSERT INTO orchestration_events',
    regex: /INSERT\s+INTO\s+orchestration_events\b/i,
  },
  // Anchored on `status` so the benign `SET current_round = ?` sync is allowed.
  { label: 'UPDATE sessions SET status', regex: /UPDATE\s+sessions\s+SET\s+status\b/i },
]

/** Recursively collect every .ts file under `dir`, excluding __tests__ trees. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__tests__') continue
      out.push(...collectTsFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('single-writer lifecycle invariant', () => {
  const files = collectTsFiles(serverRoot)

  it('scans a non-trivial number of server source files', () => {
    // Sanity check the walk actually found the server tree — guards against a
    // silently-empty scan giving a false-green result.
    expect(files.length).toBeGreaterThan(10)
  })

  it('has zero ad-hoc session/orchestration lifecycle writes', () => {
    const violations: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf-8')
      for (const { label, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(src)) {
          violations.push(`${label} found in ${file}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('tolerates the benign projection round/run sync (regex must not over-match)', () => {
    // Self-check: the status regex must NOT flag the allowed pointer-sync write.
    const benign = "UPDATE sessions SET current_round = ?, current_map_run = ?, updated_at = datetime('now')"
    const statusRegex = FORBIDDEN_PATTERNS.find((p) => p.label === 'UPDATE sessions SET status')!.regex
    expect(statusRegex.test(benign)).toBe(false)
  })
})
