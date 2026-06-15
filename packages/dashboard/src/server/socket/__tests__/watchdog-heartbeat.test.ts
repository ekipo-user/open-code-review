/**
 * Classical (Detroit-school) tests for the watchdog's liveness-heartbeat
 * writer (round-1 S19), exercised against a real node:sqlite database.
 *
 * The bumper's observable contract:
 *   - writes `last_heartbeat_at` for an in-flight row,
 *   - throttles to at most one write per HEARTBEAT_THROTTLE_MS,
 *   - never writes after the entry is finalized,
 *   - the `finished_at IS NULL` guard makes a bump on a finished row a no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from '@open-code-review/persistence'
import { makeTempWorkspace, removeTempWorkspace } from '@open-code-review/persistence/test-support'
import { openDb } from '../../db.js'
import { makeHeartbeatBumper } from '../watchdog.js'
import type { ProcessEntry } from '../process-registry.js'

let workspace: string
let ocrDir: string
let db: Database

// A timestamp far enough in the past that any real `datetime('now')` write is
// distinguishable from it.
const SENTINEL = '2000-01-01 00:00:00'

function makeEntry(executionId: number, overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    process: null,
    executionId,
    uid: `uid-${executionId}`,
    argsJson: '[]',
    outputBuffer: '',
    commandStr: 'ocr review',
    startedAt: new Date().toISOString(),
    detached: true,
    cancelled: false,
    ...overrides,
  }
}

function insertRow(opts: { heartbeat?: string; finished?: string | null } = {}): number {
  db.run(
    `INSERT INTO command_executions (command, started_at, last_heartbeat_at, finished_at)
     VALUES (?, datetime('now'), ?, ?)`,
    ['ocr review', opts.heartbeat ?? SENTINEL, opts.finished ?? null],
  )
  const idResult = db.exec('SELECT last_insert_rowid() as id')
  return (idResult[0]?.values[0]?.[0] as number) ?? 0
}

function readHeartbeat(id: number): string | null {
  const res = db.exec('SELECT last_heartbeat_at FROM command_executions WHERE id = ?', [id])
  return (res[0]?.values[0]?.[0] as string | null) ?? null
}

beforeEach(async () => {
  workspace = makeTempWorkspace('watchdog-heartbeat-')
  ocrDir = join(workspace, '.ocr')
  mkdirSync(join(ocrDir, 'data'), { recursive: true })
  db = await openDb(ocrDir)
})

afterEach(() => {
  removeTempWorkspace(workspace)
})

describe('makeHeartbeatBumper', () => {
  it('writes last_heartbeat_at for an in-flight row', () => {
    const id = insertRow()
    const bump = makeHeartbeatBumper(db, id, makeEntry(id))
    bump()
    expect(readHeartbeat(id)).not.toBe(SENTINEL)
  })

  it('throttles back-to-back bumps to a single write', () => {
    const id = insertRow()
    const entry = makeEntry(id)
    const bump = makeHeartbeatBumper(db, id, entry)
    bump() // first write sets entry.lastBeatWrite
    // Reset the column behind the bumper's back; a throttled second call must
    // NOT overwrite it.
    db.run('UPDATE command_executions SET last_heartbeat_at = ? WHERE id = ?', [SENTINEL, id])
    bump()
    expect(readHeartbeat(id)).toBe(SENTINEL)
  })

  it('does not write once the entry is finalized', () => {
    const id = insertRow()
    const entry = makeEntry(id, { finalized: true })
    const bump = makeHeartbeatBumper(db, id, entry)
    bump()
    expect(readHeartbeat(id)).toBe(SENTINEL)
  })

  it('is a no-op on an already-finished row (finished_at IS NULL guard)', () => {
    const id = insertRow({ finished: new Date().toISOString() })
    // Fresh entry → no throttle guard; the write is attempted but matches 0 rows.
    const bump = makeHeartbeatBumper(db, id, makeEntry(id))
    bump()
    expect(readHeartbeat(id)).toBe(SENTINEL)
  })
})
