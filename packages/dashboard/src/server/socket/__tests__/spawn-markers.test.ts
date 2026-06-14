/**
 * Classical (Detroit-school) tests for the per-execution spawn markers.
 *
 * Exercised against a real filesystem — no mocks. These markers are the
 * fallback linkage the CLI's `ocr state begin` reads, so the write/clear
 * round-trip and the per-execution isolation (one spawn's marker never
 * clobbers another's, round-1 S25) are the load-bearing behaviors.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempWorkspace, removeTempWorkspace } from '@open-code-review/persistence/test-support'
import { writeSpawnMarker, clearSpawnMarker, clearAllSpawnMarkers } from '../spawn-markers.js'

let workspace: string
let ocrDir: string

function markerDir(): string {
  return join(ocrDir, 'data', 'dashboard-active-spawn')
}

beforeEach(() => {
  workspace = makeTempWorkspace('spawn-markers-')
  ocrDir = join(workspace, '.ocr')
  mkdirSync(join(ocrDir, 'data'), { recursive: true })
})

afterEach(() => {
  removeTempWorkspace(workspace)
})

describe('writeSpawnMarker', () => {
  it('creates a per-execution marker carrying the uid + pid', () => {
    writeSpawnMarker(ocrDir, 'exec-uid-1', 4242)
    const path = join(markerDir(), 'exec-uid-1.json')
    expect(existsSync(path)).toBe(true)
    const payload = JSON.parse(readFileSync(path, 'utf-8'))
    expect(payload.execution_uid).toBe('exec-uid-1')
    expect(payload.pid).toBe(4242)
    expect(typeof payload.started_at).toBe('string')
  })

  it('writes the marker with owner-only (0o600) permissions', () => {
    writeSpawnMarker(ocrDir, 'exec-uid-1', 1)
    const mode = statSync(join(markerDir(), 'exec-uid-1.json')).mode & 0o777
    // Windows ignores the unix mode bits; assert only where they are honored.
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600)
    }
  })

  it('sanitizes a path-traversing uid so the marker cannot escape its directory', () => {
    writeSpawnMarker(ocrDir, '../../escape', 7)
    // No file appears outside the marker dir…
    expect(existsSync(join(ocrDir, 'escape.json'))).toBe(false)
    expect(existsSync(join(ocrDir, 'data', 'escape.json'))).toBe(false)
    // …the sanitized name lands inside it instead.
    const entries = readdirSync(markerDir())
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/escape\.json$/)
    expect(entries[0]).not.toContain('/')
  })

  it('keeps concurrent markers independent — no last-write-wins clobber', () => {
    writeSpawnMarker(ocrDir, 'exec-a', 11)
    writeSpawnMarker(ocrDir, 'exec-b', 22)
    expect(existsSync(join(markerDir(), 'exec-a.json'))).toBe(true)
    expect(existsSync(join(markerDir(), 'exec-b.json'))).toBe(true)
  })
})

describe('clearSpawnMarker', () => {
  it('removes only the named execution marker, leaving siblings intact', () => {
    writeSpawnMarker(ocrDir, 'exec-a', 11)
    writeSpawnMarker(ocrDir, 'exec-b', 22)
    clearSpawnMarker(ocrDir, 'exec-a')
    expect(existsSync(join(markerDir(), 'exec-a.json'))).toBe(false)
    expect(existsSync(join(markerDir(), 'exec-b.json'))).toBe(true)
  })

  it('is idempotent — clearing an absent marker does not throw', () => {
    expect(() => clearSpawnMarker(ocrDir, 'never-written')).not.toThrow()
  })
})

describe('clearAllSpawnMarkers', () => {
  it('removes the whole marker directory and the legacy single-file marker', () => {
    writeSpawnMarker(ocrDir, 'exec-a', 11)
    writeSpawnMarker(ocrDir, 'exec-b', 22)
    const legacy = join(ocrDir, 'data', 'dashboard-active-spawn.json')
    writeFileSync(legacy, JSON.stringify({ execution_uid: 'legacy', pid: 1 }))

    clearAllSpawnMarkers(ocrDir)

    expect(existsSync(markerDir())).toBe(false)
    expect(existsSync(legacy)).toBe(false)
  })

  it('is safe to call when nothing has been written', () => {
    expect(() => clearAllSpawnMarkers(ocrDir)).not.toThrow()
  })
})
