import { describe, it, expect } from 'vitest'
import { resolveDiscourseConfig, parseDiscourseContent } from './discourse-block'

describe('resolveDiscourseConfig — unknown-type tolerance (issue #28)', () => {
  it('resolves each known discourse type to a defined icon and label', () => {
    for (const [type, label] of [
      ['AGREE', 'Agree'],
      ['CHALLENGE', 'Challenge'],
      ['CONNECT', 'Connect'],
      ['SURFACE', 'Surface'],
    ] as const) {
      const config = resolveDiscourseConfig(type)
      expect(config.icon).toBeDefined()
      expect(config.label).toBe(label)
    }
  })

  it('falls back to a neutral config for an unknown type instead of throwing', () => {
    const config = resolveDiscourseConfig('WAT')
    expect(config.icon).toBeDefined() // would be undefined.icon → crash before the guard
    expect(config.label).toBe('WAT') // surfaces the raw type rather than crashing
  })

  it('uses a default label when the unknown type is blank', () => {
    expect(resolveDiscourseConfig('   ').label).toBe('Discourse')
  })
})

describe('parseDiscourseContent', () => {
  it('extracts sections by known type', () => {
    const md = '### AGREE — alice\nLooks good.\n\n### CHALLENGE\nNot so fast.'
    const sections = parseDiscourseContent(md)
    expect(sections.map((s) => s.type)).toEqual(['AGREE', 'CHALLENGE'])
    expect(sections[0]?.reviewer).toBe('alice')
  })
})
