import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fail-fast liveness ceilings (this suite never flaked; the 120s bump was
    // sympathetic over-inflation). testTimeout 60s is ≥3x the real worst case;
    // hookTimeout 60s covers the server-boot beforeAll with margin on Windows.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
