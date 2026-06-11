import { describe, it, expect } from 'vitest'
import { isModelVendor } from '@open-code-review/cli/models'
import { ClaudeCodeAdapter } from '../claude-adapter.js'
import { OpenCodeAdapter } from '../opencode-adapter.js'
import type { AiCliAdapter } from '../types.js'

/**
 * Every registered runtime adapter MUST have a model-listing strategy in the
 * CLI's vendor strategy table (`VENDOR_MODEL_STRATEGIES`) — the single source
 * of truth behind `ocr models list` and `GET /api/team/models`. Adapters no
 * longer carry their own `listModels()` (issue #39: the duplicated dead path
 * drifted into a permanently-failing probe), so a new vendor adapter fails
 * here until its strategy-table entry exists.
 */
const ADAPTERS: AiCliAdapter[] = [new ClaudeCodeAdapter(), new OpenCodeAdapter()]

describe('adapter ↔ model-strategy-table agreement', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.binary} has a model-listing strategy`, () => {
      expect(isModelVendor(adapter.binary)).toBe(true)
    })
  }
})
