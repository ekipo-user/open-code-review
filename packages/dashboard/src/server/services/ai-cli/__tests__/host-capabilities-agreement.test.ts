import { describe, it, expect } from 'vitest'
import { hostCapabilitiesFor } from '@open-code-review/platform'
import { createRegisteredAdapters } from '../index.js'

/**
 * Every adapter's runtime capability flags MUST equal the single platform
 * authority (`hostCapabilitiesFor`), so the install-time CLI registry
 * (config.getHostCapabilities, which also derives from it) and the runtime
 * adapters can never silently diverge — the regression class the next change
 * (evolve-phase4-host-aware-spawning) routes Phase 4 on. Issue #28 review
 * Important-1. Adding an adapter for a new binary fails here until that binary
 * is declared in the platform capability table. The adapter list comes from
 * `createRegisteredAdapters()` — the same registry `AiCliService` boots with.
 */
describe('adapter ↔ platform host-capability agreement', () => {
  for (const adapter of createRegisteredAdapters()) {
    it(`${adapter.binary} flags match hostCapabilitiesFor('${adapter.binary}')`, () => {
      const caps = hostCapabilitiesFor(adapter.binary)
      expect(adapter.supportsSubagentSpawn).toBe(caps.subagentSpawn)
      expect(adapter.supportsPerTaskModel).toBe(caps.perTaskModel)
    })
  }
})
