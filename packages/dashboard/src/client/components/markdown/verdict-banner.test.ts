import { describe, it, expect } from 'vitest'
import { hasVerdictMismatch } from './verdict-banner'

describe('hasVerdictMismatch — legacy verdict/blocker-count direction', () => {
  it('flags APPROVE beside a non-zero blocker count', () => {
    expect(hasVerdictMismatch('APPROVE', 1)).toBe(true)
    expect(hasVerdictMismatch('accept_with_followups', 2)).toBe(true) // legacy alias → APPROVE
  })

  it('flags REQUEST CHANGES beside a zero blocker count', () => {
    expect(hasVerdictMismatch('REQUEST CHANGES', 0)).toBe(true)
    expect(hasVerdictMismatch('changes requested', 0)).toBe(true) // legacy alias
  })

  it('does not flag a consistent row', () => {
    expect(hasVerdictMismatch('APPROVE', 0)).toBe(false)
    expect(hasVerdictMismatch('REQUEST CHANGES', 3)).toBe(false)
  })

  it('never flags NEEDS DISCUSSION (unconstrained on blockers)', () => {
    expect(hasVerdictMismatch('NEEDS DISCUSSION', 0)).toBe(false)
    expect(hasVerdictMismatch('NEEDS DISCUSSION', 5)).toBe(false)
  })

  it('does not flag when the blocker count is unknown', () => {
    expect(hasVerdictMismatch('APPROVE', undefined)).toBe(false)
    expect(hasVerdictMismatch('REQUEST CHANGES', undefined)).toBe(false)
  })

  it('does not flag an unmappable verdict (renders neutral fallback instead)', () => {
    expect(hasVerdictMismatch('totally unknown verdict', 5)).toBe(false)
  })
})
