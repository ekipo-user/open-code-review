/**
 * Classical (Detroit-school) tests for the execution finalizer.
 *
 * `tryClaimFinalization` is pure and tested directly. `finishExecution` is
 * exercised against a real node:sqlite database with a recording `io` fake
 * standing in for the out-of-process socket boundary (the one collaborator
 * that is genuinely external). No internal mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Server as SocketIOServer } from 'socket.io'
import type { Database } from '@open-code-review/persistence'
import { CANCELLED_EXIT_CODE } from '@open-code-review/persistence'
import { makeTempWorkspace, removeTempWorkspace } from '@open-code-review/persistence/test-support'
import type { FileTailer } from '../../services/ai-cli/file-tailer.js'
import { openDb } from '../../db.js'
import { tryClaimFinalization, finishExecution } from '../finalizer.js'
import { activeCommands, type ProcessEntry } from '../process-registry.js'

let workspace: string
let ocrDir: string
let db: Database

type EmittedEvent = { event: string; payload: unknown }

function recordingIo(): { io: SocketIOServer; emitted: EmittedEvent[] } {
  const emitted: EmittedEvent[] = []
  const io = {
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload })
      return true
    },
  } as unknown as SocketIOServer
  return { io, emitted }
}

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

function insertRow(uid: string): number {
  db.run(
    `INSERT INTO command_executions (uid, command, args, started_at, last_heartbeat_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [uid, 'ocr review', '[]'],
  )
  const idResult = db.exec('SELECT last_insert_rowid() as id')
  return (idResult[0]?.values[0]?.[0] as number) ?? 0
}

function readRow(id: number): { exit_code: number | null; finished_at: string | null; output: string | null; pid: number | null } {
  const res = db.exec(
    'SELECT exit_code, finished_at, output, pid FROM command_executions WHERE id = ?',
    [id],
  )
  const row = res[0]?.values[0] ?? []
  return {
    exit_code: (row[0] as number | null) ?? null,
    finished_at: (row[1] as string | null) ?? null,
    output: (row[2] as string | null) ?? null,
    pid: (row[3] as number | null) ?? null,
  }
}

beforeEach(async () => {
  workspace = makeTempWorkspace('finalizer-')
  ocrDir = join(workspace, '.ocr')
  mkdirSync(join(ocrDir, 'data'), { recursive: true })
  db = await openDb(ocrDir)
})

afterEach(() => {
  activeCommands.clear()
  removeTempWorkspace(workspace)
})

describe('tryClaimFinalization (S23)', () => {
  it('the first caller wins and releases the watchdog timer + tailer', () => {
    let tailerStopped = false
    const tailer = { stop: () => { tailerStopped = true } } as unknown as FileTailer
    const watchdog = setInterval(() => {}, 60_000)
    const entry = makeEntry(1, { watchdog, tailer })

    expect(tryClaimFinalization(entry)).toBe(true)
    expect(entry.finalized).toBe(true)
    expect(entry.watchdog).toBeUndefined()
    expect(entry.tailer).toBeUndefined()
    expect(tailerStopped).toBe(true)
  })

  it('a second claim on the same entry loses', () => {
    const entry = makeEntry(1)
    expect(tryClaimFinalization(entry)).toBe(true)
    expect(tryClaimFinalization(entry)).toBe(false)
  })

  it('returns true for an undefined entry — the DB CAS arbitrates the rest', () => {
    expect(tryClaimFinalization(undefined)).toBe(true)
  })
})

describe('finishExecution', () => {
  it('finalizes the row (exit code, finished_at, output) and nulls the pid', () => {
    const id = insertRow('uid-finish')
    db.run('UPDATE command_executions SET pid = ? WHERE id = ?', [9999, id])
    const entry = makeEntry(id)
    activeCommands.set(id, entry)
    const { io, emitted } = recordingIo()

    finishExecution(io, db, ocrDir, id, 0, 'final output')

    const row = readRow(id)
    expect(row.exit_code).toBe(0)
    expect(row.finished_at).not.toBeNull()
    expect(row.output).toBe('final output')
    expect(row.pid).toBeNull()
    expect(emitted.some((e) => e.event === 'command:finished')).toBe(true)
    expect(activeCommands.has(id)).toBe(false)
  })

  it('cancel wins the recorded exit code regardless of the raw code', () => {
    const id = insertRow('uid-cancel')
    activeCommands.set(id, makeEntry(id, { cancelled: true }))
    const { io } = recordingIo()

    // A `result`-driven finalize would pass 0, but the cancel flag must win.
    finishExecution(io, db, ocrDir, id, 0, 'out')

    expect(readRow(id).exit_code).toBe(CANCELLED_EXIT_CODE)
  })

  it('is idempotent across triggers — a later finalize cannot clobber the first (DB CAS)', () => {
    const id = insertRow('uid-cas')
    activeCommands.set(id, makeEntry(id))
    const { io, emitted } = recordingIo()

    finishExecution(io, db, ocrDir, id, 0, 'first')
    // Entry already removed; a late close arriving with a different code must
    // not overwrite the recorded outcome (WHERE finished_at IS NULL → 0 rows).
    finishExecution(io, db, ocrDir, id, 1, 'second')

    const row = readRow(id)
    expect(row.exit_code).toBe(0)
    expect(row.output).toBe('first')
    expect(emitted.filter((e) => e.event === 'command:finished')).toHaveLength(1)
  })
})
