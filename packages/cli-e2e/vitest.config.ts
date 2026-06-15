import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // These e2e cases spawn the REAL built `ocr` binary many times each
    // (init → begin → advance ×N → complete-round, …). On the Windows runner
    // every spawn pays a slow `.cmd` shim + node + node:sqlite startup, so a
    // single case can take ~55s — right at the old 60s ceiling, which made it
    // flake (a docs-only push reddened main on a Windows e2e timeout). 120s
    // gives ~2x headroom over the observed worst case without letting a
    // genuinely hung test sit forever (the CI job itself caps at 30 min).
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
