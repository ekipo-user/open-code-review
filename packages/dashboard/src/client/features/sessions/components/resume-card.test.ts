import { describe, it, expect } from 'vitest'
import { resumeVariantForNextAction } from './resume-card'

describe('resumeVariantForNextAction', () => {
  it('maps forward_resume → the recoverable paused card', () => {
    expect(resumeVariantForNextAction('forward_resume')).toBe('paused')
  })

  it('maps abort_or_fresh → the exhausted card (Start fresh / Mark abandoned)', () => {
    expect(resumeVariantForNextAction('abort_or_fresh')).toBe('exhausted')
  })

  it('maps finish/none → the clean completed card', () => {
    expect(resumeVariantForNextAction('finish')).toBe('completed')
    expect(resumeVariantForNextAction('none')).toBe('completed')
  })

  it('returns null for live-run actions (no recovery card)', () => {
    expect(resumeVariantForNextAction('advance')).toBeNull()
    expect(resumeVariantForNextAction('complete_round')).toBeNull()
    expect(resumeVariantForNextAction('wait')).toBeNull()
    expect(resumeVariantForNextAction(undefined)).toBeNull()
  })
})
