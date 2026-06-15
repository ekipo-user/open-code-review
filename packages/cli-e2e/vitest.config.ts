import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // testTimeout is a fail-fast LIVENESS ceiling, not a performance knob. Each
    // case spawns the real `ocr` binary; arrange-heavy preconditions are now
    // amortized once via buildSynthesisFixture (see helpers/synthesis-fixture.ts),
    // so per-test cost is ~1 spawn and the genuine worst case (agent-sessions'
    // real heartbeat-staleness sleeps + a few spawns) is well under ~20s. 60s is
    // ≥3x that — a real hang fails fast rather than burning two minutes.
    testTimeout: 60_000,
    // hookTimeout covers the ONE-TIME synthesis fixture build (~7 real CLI spawns
    // ≈ up to ~55s on a cold Windows runner). Generous on purpose: it is a single
    // amortized setup, not a per-test budget, so 2x headroom here costs nothing
    // and the per-test flake surface is gone.
    hookTimeout: 120_000,
  },
});
