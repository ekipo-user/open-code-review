import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readReviewersMeta } from './reviewers.js'

let ocrDir: string

beforeEach(() => {
  ocrDir = mkdtempSync(join(tmpdir(), 'ocr-reviewers-route-'))
})

afterEach(() => {
  rmSync(ocrDir, { recursive: true, force: true })
})

function writeMeta(reviewers: unknown[]) {
  writeFileSync(
    join(ocrDir, 'reviewers-meta.json'),
    JSON.stringify({ schema_version: 1, generated_at: 'now', reviewers }, null, 2),
  )
}

describe('readReviewersMeta — icon backfill (issue #28)', () => {
  it('backfills a missing icon so the API never emits an icon-less reviewer', () => {
    writeMeta([
      // built-in id, icon omitted entirely
      { id: 'architect', name: 'Architect', tier: 'holistic', description: 'd', focus_areas: [], is_default: true, is_builtin: true },
      // unknown custom reviewer, icon omitted
      { id: 'my-custom', name: 'Custom', tier: 'custom', description: 'd', focus_areas: [], is_default: false, is_builtin: false },
    ])

    const { reviewers } = readReviewersMeta(ocrDir)

    expect(reviewers[0]?.icon).toBe('blocks') // architect → blocks
    expect(reviewers[1]?.icon).toBe('user') // unknown custom → user
    expect(reviewers.every((r) => typeof r.icon === 'string' && r.icon.length > 0)).toBe(true)
  })

  it('preserves an explicit icon', () => {
    writeMeta([
      { id: 'architect', name: 'Architect', tier: 'holistic', icon: 'crown', description: 'd', focus_areas: [], is_default: true, is_builtin: true },
    ])
    expect(readReviewersMeta(ocrDir).reviewers[0]?.icon).toBe('crown')
  })

  it('returns empty result when the file is absent', () => {
    expect(readReviewersMeta(ocrDir)).toEqual({ reviewers: [], defaults: [] })
  })

  it('derives defaults from is_default', () => {
    writeMeta([
      { id: 'architect', name: 'A', tier: 'holistic', icon: 'blocks', description: 'd', focus_areas: [], is_default: true, is_builtin: true },
      { id: 'frontend', name: 'F', tier: 'specialist', icon: 'layout', description: 'd', focus_areas: [], is_default: false, is_builtin: true },
    ])
    expect(readReviewersMeta(ocrDir).defaults).toEqual(['architect'])
  })
})
