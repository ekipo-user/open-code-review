/**
 * Pinning tests for the watchdog tick decision (round-2 SF1).
 *
 * The two load-bearing invariants from the round-2 discourse:
 *   1. "The watchdog finalizes a dead-pid entry whose close never fired" —
 *      finalization is gated by deadlines only, never by child liveness.
 *   2. "The heartbeat is not bumped for an exited child" — an exited,
 *      no-result child stays claimable by the liveness sweep's orphan backstop.
 */
import { describe, it, expect } from 'vitest'
import { decideWatchdogTick, type WatchdogTickInput } from '../command-runner'

const T0 = 1_000_000 // arbitrary epoch base

function input(overrides: Partial<WatchdogTickInput>): WatchdogTickInput {
  return {
    exited: false,
    resultSeenAt: undefined,
    resultIsError: undefined,
    startedAtMs: T0,
    nowMs: T0 + 60_000, // 1 min in — inside every default bound
    postResultGraceMs: 30_000,
    hardDeadlineMs: 60 * 60 * 1000,
    ...overrides,
  }
}

describe('decideWatchdogTick', () => {
  it('beats the heartbeat for a healthy live child inside all bounds', () => {
    expect(decideWatchdogTick(input({}))).toEqual({ action: 'beat' })
  })

  it('waits (no beat) for an exited child inside all bounds — preserves the orphan backstop', () => {
    // Invariant 2: bumping a dead child's heartbeat would disarm the liveness
    // sweep for the exited-no-result case.
    expect(decideWatchdogTick(input({ exited: true }))).toEqual({ action: 'wait' })
  })

  it('finalizes a dead child whose close never fired, once the result grace passes', () => {
    // Invariant 1 — the original incident topology in pipe-fallback mode:
    // child exited, grandchild holds the inherited pipe, close withheld.
    // Must finalize with the TRUE verdict, and must NOT reap (the PID may be
    // recycled; escaped descendants have reparented to PID 1 anyway).
    const d = decideWatchdogTick(
      input({ exited: true, resultSeenAt: T0, nowMs: T0 + 31_000 }),
    )
    expect(d).toEqual({
      action: 'finalize',
      reap: false,
      exitCode: 0,
      reason: 'result-grace',
    })
  })

  it('reaps + finalizes a LIVE child that will not exit after its result', () => {
    const d = decideWatchdogTick(
      input({ exited: false, resultSeenAt: T0, nowMs: T0 + 31_000 }),
    )
    expect(d).toEqual({
      action: 'finalize',
      reap: true,
      exitCode: 0,
      reason: 'result-grace',
    })
  })

  it('carries the result error flag into the finalize code', () => {
    const d = decideWatchdogTick(
      input({ resultSeenAt: T0, resultIsError: true, nowMs: T0 + 31_000 }),
    )
    expect(d).toMatchObject({ action: 'finalize', exitCode: 1 })
  })

  it('does not finalize within the result grace window', () => {
    expect(
      decideWatchdogTick(input({ resultSeenAt: T0, nowMs: T0 + 29_000 })),
    ).toEqual({ action: 'beat' })
  })

  it('finalizes with -5 at the hard deadline regardless of liveness', () => {
    const past = input({ nowMs: T0 + 61 * 60 * 1000 })
    expect(decideWatchdogTick({ ...past, exited: false })).toEqual({
      action: 'finalize',
      reap: true,
      exitCode: -5,
      reason: 'hard-deadline',
    })
    // Dead child past the deadline still FINALIZES — just without reaping.
    expect(decideWatchdogTick({ ...past, exited: true })).toEqual({
      action: 'finalize',
      reap: false,
      exitCode: -5,
      reason: 'hard-deadline',
    })
  })

  it('prefers the true result verdict when both grace and deadline have passed', () => {
    const d = decideWatchdogTick(
      input({
        resultSeenAt: T0,
        resultIsError: false,
        nowMs: T0 + 2 * 60 * 60 * 1000, // way past both
      }),
    )
    expect(d).toMatchObject({ action: 'finalize', exitCode: 0, reason: 'result-grace' })
  })
})
