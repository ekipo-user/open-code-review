import { defineConfig, devices } from "@playwright/test";
import { nxE2EPreset } from "@nx/playwright/preset";
import { fileURLToPath } from "node:url";

const baseURL = "http://localhost:5173";

export default defineConfig({
  ...nxE2EPreset(fileURLToPath(import.meta.url), { testDir: "./src" }),
  // The system-under-test is a SINGLE Vite dev server (one module graph, one
  // global dependency optimizer). The Nx preset defaults to `fullyParallel`
  // with `workers: undefined` (→ one worker per core) off CI, which points
  // multiple browser contexts at that one server simultaneously. Concurrent
  // cold `goto("/")` loads race Vite's optimizer; an optimize pass forces a
  // full-page reload and emits transient console errors — non-deterministic
  // failures that the preset's local `retries: 0` turns into a hard task
  // failure (CI hides the same flake behind `retries: 2`). Serialize instead:
  // the shared dev server is the resource, so one worker is the correct model,
  // not a retry-masked band-aid.
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npx nx dev dashboard",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: "../..",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
