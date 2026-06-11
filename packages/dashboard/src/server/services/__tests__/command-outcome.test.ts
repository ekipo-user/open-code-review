import { describe, it, expect } from 'vitest'
import {
  deriveCommandOutcome,
  deriveCancellationReason,
} from '../command-outcome'

describe('deriveCommandOutcome', () => {
  it('returns null when the command has not finished', () => {
    expect(deriveCommandOutcome(null, null)).toBeNull()
    expect(deriveCommandOutcome(null, 'open_no_artifact')).toBeNull()
    expect(deriveCommandOutcome(null, 'complete')).toBeNull()
  })

  it("returns 'cancelled' for the user-cancel (-2) and cascade-close (-4) sentinels", () => {
    expect(deriveCommandOutcome(-2, null)).toBe('cancelled')
    expect(deriveCommandOutcome(-2, 'complete')).toBe('cancelled')
    // -4 = a child terminated by its parent workflow close — not a failure.
    expect(deriveCommandOutcome(-4, null)).toBe('cancelled')
    expect(deriveCommandOutcome(-4, 'complete')).toBe('cancelled')
  })

  it("returns 'failed' for any other non-zero exit code", () => {
    expect(deriveCommandOutcome(1, null)).toBe('failed')
    expect(deriveCommandOutcome(-1, null)).toBe('failed')
    expect(deriveCommandOutcome(127, 'open_no_artifact')).toBe('failed')
    expect(deriveCommandOutcome(137, 'complete')).toBe('failed')
  })

  it("explicitly recognizes the watchdog hard-deadline sentinel (-5) as 'failed'", () => {
    // Not a silent fall-through: -5 is a named, handled terminal (round-1 SF9).
    expect(deriveCommandOutcome(-5, null)).toBe('failed')
    expect(deriveCommandOutcome(-5, 'complete')).toBe('failed')
    // …and it is NOT a cancellation.
    expect(deriveCancellationReason(-5)).toBeNull()
  })

  describe('exit 0', () => {
    it("returns 'success' for non-workflow commands (no linked workflow)", () => {
      expect(deriveCommandOutcome(0, null)).toBe('success')
    })

    it("returns 'success' only when the workflow is genuinely complete", () => {
      expect(deriveCommandOutcome(0, 'complete')).toBe('success')
    })

    it("returns 'incomplete' for closed-without-artifact (the 'completed too soon' bug)", () => {
      // The headline case: the workflow is closed but its current round/run
      // never produced a terminal artifact. Previously this read as success.
      expect(deriveCommandOutcome(0, 'closed_without_artifact')).toBe('incomplete')
    })

    it("returns 'incomplete' when the workflow is still open (macOS-sleep / drop)", () => {
      expect(deriveCommandOutcome(0, 'open_no_artifact')).toBe('incomplete')
      expect(deriveCommandOutcome(0, 'in_flight')).toBe('incomplete')
    })
  })
})

describe('deriveCancellationReason', () => {
  it("maps -2 (user cancel) to 'user'", () => {
    expect(deriveCancellationReason(-2)).toBe('user')
  })

  it("maps -4 (cascade close) to 'cascade'", () => {
    expect(deriveCancellationReason(-4)).toBe('cascade')
  })

  it('returns null for non-cancel exit codes and not-yet-finished', () => {
    expect(deriveCancellationReason(0)).toBeNull()
    expect(deriveCancellationReason(1)).toBeNull()
    expect(deriveCancellationReason(null)).toBeNull()
    // Other sentinels (e.g. -1 spawn error, -3 orphan) are not cancels.
    expect(deriveCancellationReason(-1)).toBeNull()
    expect(deriveCancellationReason(-3)).toBeNull()
  })

  it("stays orthogonal to outcome: both cancel reasons still bucket to 'cancelled'", () => {
    // Cross-check the invariant the field exists to support — the 4-value
    // outcome union is unchanged; cancellation_reason is the discriminator.
    expect(deriveCommandOutcome(-2, null)).toBe('cancelled')
    expect(deriveCommandOutcome(-4, null)).toBe('cancelled')
    expect(deriveCancellationReason(-2)).toBe('user')
    expect(deriveCancellationReason(-4)).toBe('cascade')
  })
})
