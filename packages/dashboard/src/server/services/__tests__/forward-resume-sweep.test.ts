import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTempWorkspace, removeTempWorkspace } from '@open-code-review/persistence/test-support'
import { openDatabase, insertAgentSession, getSession } from '@open-code-review/persistence'
import {
  stateBegin,
  stateAdvance,
  tryAcquireForwardResumeLease,
} from '@open-code-review/persistence/state'
import type { Database } from '@open-code-review/persistence'
import { planForwardResume, runForwardResumeSweep } from '../forward-resume-sweep.js'

let tmpDir: string
let ocrDir: string

beforeEach(() => {
  tmpDir = makeTempWorkspace('ocr-fr-sweep-test-')
  ocrDir = join(tmpDir, '.ocr')
})
afterEach(() => removeTempWorkspace(tmpDir))

async function db(): Promise<Database> {
  return await openDatabase(join(ocrDir, 'data', 'ocr.db'))
}

async function strandedAtReviews(id: string): Promise<void> {
  await stateBegin({ sessionId: id, branch: 'feat/x', workflowType: 'review', sessionDir: join(ocrDir, 'sessions', id), ocrDir })
  for (const phase of ['change-context', 'analysis', 'reviews']) {
    await stateAdvance({ sessionId: id, phase, ocrDir })
  }
}

/** Add an agent-session instance, optionally with a pid / bound vendor id /
 *  finished. */
function addInstance(
  handle: Database,
  workflowId: string,
  opts: { id: string; pid?: number; vendorSessionId?: string; finished?: boolean },
): void {
  insertAgentSession(handle, { id: opts.id, workflow_id: workflowId, vendor: 'claude', pid: opts.pid ?? null })
  if (opts.vendorSessionId) {
    handle.run('UPDATE command_executions SET vendor_session_id = ? WHERE uid = ?', [opts.vendorSessionId, opts.id])
  }
  if (opts.finished) {
    handle.run("UPDATE command_executions SET finished_at = datetime('now'), exit_code = 0 WHERE uid = ?", [opts.id])
  }
}

const DEAD = () => false
const ALIVE = () => true
const CFG = { maxAttempts: 2, heartbeatMs: 60_000 }

describe('planForwardResume', () => {
  it('plans resume for a dead, incomplete run with a captured vendor id', async () => {
    await strandedAtReviews('s-resume')
    const h = await db()
    addInstance(h, 's-resume', { id: 'i1', pid: 4242, vendorSessionId: 'vs-1' })
    const plan = planForwardResume(h, { ...CFG, isAlive: DEAD })
    expect(plan).toEqual([{ sessionId: 's-resume', action: 'resume' }])
  })

  it('plans handoff (no auto-spawn) when no vendor id was captured', async () => {
    await strandedAtReviews('s-handoff')
    const h = await db()
    addInstance(h, 's-handoff', { id: 'i1', pid: 4242 }) // dead pid, no vendor id
    const plan = planForwardResume(h, { ...CFG, isAlive: DEAD })
    expect(plan).toEqual([{ sessionId: 's-handoff', action: 'handoff' }])
  })

  it('skips a run whose owning turn is still alive (live pid)', async () => {
    await strandedAtReviews('s-live')
    const h = await db()
    addInstance(h, 's-live', { id: 'i1', pid: 4242, vendorSessionId: 'vs-1' })
    expect(planForwardResume(h, { ...CFG, isAlive: ALIVE })).toEqual([])
  })

  it('skips a run with no positive death evidence (pid-less, unfinished instance)', async () => {
    await strandedAtReviews('s-nopid')
    const h = await db()
    addInstance(h, 's-nopid', { id: 'i1', vendorSessionId: 'vs-1' }) // no pid, not finished
    expect(planForwardResume(h, { ...CFG, isAlive: DEAD })).toEqual([])
  })

  it('skips a run with no journaled instances at all', async () => {
    await strandedAtReviews('s-noinst')
    const h = await db()
    expect(planForwardResume(h, { ...CFG, isAlive: DEAD })).toEqual([])
  })

  it('plans cap_close once the forward-resume cap is exhausted', async () => {
    await strandedAtReviews('s-cap')
    const h = await db()
    addInstance(h, 's-cap', { id: 'i1', pid: 4242, vendorSessionId: 'vs-1' })
    const round = getSession(h, 's-cap')!.current_round
    const base = Date.now()
    tryAcquireForwardResumeLease(h, 's-cap', round, { leaseMs: 1000, maxAttempts: 2, nowMs: base })
    tryAcquireForwardResumeLease(h, 's-cap', round, { leaseMs: 1000, maxAttempts: 2, nowMs: base + 5000 })
    expect(planForwardResume(h, { ...CFG, isAlive: DEAD })).toEqual([{ sessionId: 's-cap', action: 'cap_close' }])
  })

  it('ignores a finished instance for liveness (ended counts as dead evidence)', async () => {
    await strandedAtReviews('s-ended')
    const h = await db()
    addInstance(h, 's-ended', { id: 'i1', pid: 4242, vendorSessionId: 'vs-1', finished: true })
    // ALIVE probe is irrelevant: the instance is ended → positive death evidence.
    expect(planForwardResume(h, { ...CFG, isAlive: ALIVE })).toEqual([{ sessionId: 's-ended', action: 'resume' }])
  })
})

describe('runForwardResumeSweep', () => {
  it('spawns resume for resumable items and closes cap-exhausted ones', async () => {
    await strandedAtReviews('r-resume')
    await strandedAtReviews('r-cap')
    const h = await db()
    addInstance(h, 'r-resume', { id: 'a', pid: 4242, vendorSessionId: 'vs-a' })
    addInstance(h, 'r-cap', { id: 'b', pid: 4243, vendorSessionId: 'vs-b' })
    const round = getSession(h, 'r-cap')!.current_round
    const base = Date.now()
    tryAcquireForwardResumeLease(h, 'r-cap', round, { leaseMs: 1000, maxAttempts: 2, nowMs: base })
    tryAcquireForwardResumeLease(h, 'r-cap', round, { leaseMs: 1000, maxAttempts: 2, nowMs: base + 5000 })

    const spawned: string[] = []
    runForwardResumeSweep({
      db: h,
      config: { ...CFG, isAlive: DEAD },
      maxAttempts: 2,
      spawnResume: (id) => spawned.push(id),
    })

    expect(spawned).toEqual(['r-resume'])
    // The cap-exhausted run is closed non-success.
    expect(getSession(h, 'r-cap')!.status).toBe('closed')
    // The resumable run is left active for its continuation.
    expect(getSession(h, 'r-resume')!.status).toBe('active')
  })
})
