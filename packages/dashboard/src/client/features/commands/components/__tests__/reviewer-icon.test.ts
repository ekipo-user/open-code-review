import { describe, it, expect } from 'vitest'
import { BUILTIN_ICON_MAP } from '@open-code-review/platform'
import { ICON_MAP } from '../reviewer-icon'

/**
 * The CLI writes the icon STRINGS from BUILTIN_ICON_MAP into reviewers-meta.json;
 * the dashboard resolves them through ICON_MAP. Every produced string must have
 * a glyph here, or the reviewer silently falls back to a generic User icon.
 * This contract test sits across the serialization boundary the two maps span
 * (issue #28 Medium-2 — the dead 'shield-check' key drift).
 */
describe('BUILTIN_ICON_MAP ↔ ICON_MAP contract', () => {
  it('every built-in reviewer icon string resolves to a dashboard glyph', () => {
    const missing = Object.entries(BUILTIN_ICON_MAP)
      .filter(([, icon]) => !(icon in ICON_MAP))
      .map(([id, icon]) => `${id} → ${icon}`)
    expect(missing).toEqual([])
  })
})
