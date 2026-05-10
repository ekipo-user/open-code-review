import { describe, it, expect } from 'vitest'
import { deriveCommandOutcome } from '../command-outcome'

describe('deriveCommandOutcome', () => {
  it('returns null when the command has not finished', () => {
    expect(deriveCommandOutcome(null, null)).toBeNull()
    expect(deriveCommandOutcome(null, 'active')).toBeNull()
    expect(deriveCommandOutcome(null, 'closed')).toBeNull()
  })

  it("returns 'cancelled' for the user-cancel sentinel (-2)", () => {
    expect(deriveCommandOutcome(-2, null)).toBe('cancelled')
    expect(deriveCommandOutcome(-2, 'active')).toBe('cancelled')
    expect(deriveCommandOutcome(-2, 'closed')).toBe('cancelled')
  })

  it("returns 'failed' for any non-zero exit code other than -2", () => {
    expect(deriveCommandOutcome(1, null)).toBe('failed')
    expect(deriveCommandOutcome(-1, null)).toBe('failed')
    expect(deriveCommandOutcome(127, 'active')).toBe('failed')
    expect(deriveCommandOutcome(137, 'closed')).toBe('failed')
  })

  describe('exit 0', () => {
    it("returns 'success' for non-workflow commands (no linked workflow)", () => {
      // Utility commands (sync-reviewers, doctor, etc.) have no workflow_id.
      expect(deriveCommandOutcome(0, null)).toBe('success')
    })

    it("returns 'success' when the linked workflow has reached terminal 'closed' status", () => {
      // Happy path — AI ran the full workflow and called `state close-session`.
      expect(deriveCommandOutcome(0, 'closed')).toBe('success')
    })

    it("returns 'incomplete' when the linked workflow is still 'active' (the macOS-sleep bug)", () => {
      // The bug case: parent process exits 0 (e.g. streaming connection
      // dropped on Mac sleep) but the AI never reached `state close-session`.
      expect(deriveCommandOutcome(0, 'active')).toBe('incomplete')
    })
  })
})
