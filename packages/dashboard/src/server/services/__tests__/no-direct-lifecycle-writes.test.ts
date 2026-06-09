/**
 * Architecture invariant: single-writer lifecycle (review Should Fix 4).
 *
 * The dashboard server must NOT perform ad-hoc session-lifecycle writes.
 * Every lifecycle close routes through `commitReasonClose` (the single
 * writer), so the event-sourced `session_completeness` projection stays
 * authoritative and the dashboard can never disagree with the agent.
 *
 * This is a cheap static guard: it scans the server source for the forbidden
 * write shapes and fails CI if a future change reintroduces a direct lifecycle
 * write — catching the regression at build time rather than as a subtle
 * "completed too soon" outcome bug in production.
 *
 * Deliberately tolerant of the benign projection-sync write
 * `UPDATE sessions SET current_round = ?, current_map_run = ?` (round/run
 * pointer sync, not a status change): the `UPDATE sessions SET status`
 * regex requires `status` somewhere in the SET list, so it does not match a
 * SET list that only touches `current_round` / `current_map_run`.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// __tests__ → services → server
const serverRoot = dirname(dirname(here))

/**
 * Forbidden ad-hoc lifecycle write shapes — all closes go through
 * commitReasonClose, all session rows are created via insertSession.
 *
 * The `UPDATE sessions SET ... status` regex matches `status` ANYWHERE in the
 * SET list (not just the first column) and tolerates a table alias
 * (`UPDATE sessions AS s SET ...`), so a column-reordering or aliasing dodge
 * can't slip an ad-hoc status write past the guard. It still does NOT match a
 * SET list that never mentions `status` (the benign round/run pointer sync).
 */
const FORBIDDEN_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: 'INSERT INTO sessions', regex: /INSERT\s+INTO\s+sessions\b/i },
  {
    label: 'REPLACE INTO sessions',
    regex: /(?:INSERT\s+OR\s+)?REPLACE\s+INTO\s+sessions\b/i,
  },
  {
    label: 'INSERT INTO orchestration_events',
    regex: /INSERT\s+INTO\s+orchestration_events\b/i,
  },
  // `status` may appear anywhere in the SET list; an optional `AS <alias>`
  // between the table and SET is tolerated. `[^;]*?` stays on the same
  // statement (no `;`) so it can't reach across into an unrelated query.
  {
    label: 'UPDATE sessions SET status',
    regex: /UPDATE\s+sessions\b(?:\s+AS\s+\w+)?\s+SET\s+[^;]*?\bstatus\b/i,
  },
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

const byLabel = (label: string): RegExp =>
  FORBIDDEN_PATTERNS.find((p) => p.label === label)!.regex

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
})

/**
 * Positive self-tests for the guard's regexes.
 *
 * The real-source scan above is only as strong as the regexes; a future
 * "simplification" that weakens a pattern would silently make the scan
 * vacuously green. These tests pin each regex against KNOWN-BAD strings it
 * MUST flag (and one known-GOOD string the status regex must NOT flag), so a
 * regex regression fails here loudly.
 */
describe('forbidden-write regexes flag known-bad SQL (regex self-test)', () => {
  it('status regex matches status anywhere in the SET list', () => {
    expect(
      byLabel('UPDATE sessions SET status').test(
        "UPDATE sessions SET current_phase='x', status='closed' WHERE id=?",
      ),
    ).toBe(true)
  })

  it('status regex matches an aliased sessions table', () => {
    expect(
      byLabel('UPDATE sessions SET status').test(
        "UPDATE sessions AS s SET status='closed'",
      ),
    ).toBe(true)
  })

  it('status regex matches status as the first SET column', () => {
    expect(
      byLabel('UPDATE sessions SET status').test(
        "UPDATE sessions SET status='closed' WHERE id=?",
      ),
    ).toBe(true)
  })

  it('REPLACE regex matches REPLACE INTO sessions', () => {
    expect(
      byLabel('REPLACE INTO sessions').test('REPLACE INTO sessions (id) VALUES (?)'),
    ).toBe(true)
  })

  it('REPLACE regex matches INSERT OR REPLACE INTO sessions', () => {
    expect(
      byLabel('REPLACE INTO sessions').test(
        'INSERT OR REPLACE INTO sessions (id) VALUES (?)',
      ),
    ).toBe(true)
  })

  it('INSERT regex matches INSERT INTO sessions', () => {
    expect(byLabel('INSERT INTO sessions').test('INSERT INTO sessions (id) VALUES (?)')).toBe(
      true,
    )
  })

  it('orchestration_events regex matches INSERT INTO orchestration_events', () => {
    expect(
      byLabel('INSERT INTO orchestration_events').test(
        'INSERT INTO orchestration_events (session_id) VALUES (?)',
      ),
    ).toBe(true)
  })

  it('tolerates the benign projection round/run sync (status regex must not over-match)', () => {
    // The allowed pointer-sync write touches current_round / current_map_run
    // but never `status`; the status regex must NOT flag it.
    const benign =
      "UPDATE sessions SET current_round = ?, current_map_run = ?, updated_at = datetime('now') WHERE id = ?"
    expect(byLabel('UPDATE sessions SET status').test(benign)).toBe(false)
  })
})
