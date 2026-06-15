import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Matches cli-e2e: these cases drive the real CLI/server over child
    // processes, which are markedly slower to spawn on the Windows runner. Give
    // 120s/60s headroom so Windows variance does not flake the API E2E job.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
