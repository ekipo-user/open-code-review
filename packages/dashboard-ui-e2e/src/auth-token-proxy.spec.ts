import { test, expect } from "@playwright/test";

declare global {
  interface Window {
    // Set by the dashboard client once its auth flow resolves; read inside a
    // page.waitForFunction callback that executes in the browser context.
    __OCR_TOKEN__?: string;
  }
}

/**
 * Regression test for the dev proxy port mismatch bug.
 *
 * When the Vite proxy targeted the wrong Express server port, the
 * /auth/token request returned Vite's index.html (HTML) instead of
 * JSON. The client tried to parse it as JSON and failed with:
 *   "Unexpected token '<', <!DOCTYPE... is not valid JSON"
 */

test.describe("auth proxy", () => {
  test("/auth/token through the proxy returns JSON, not HTML", async ({
    request,
  }) => {
    // Direct API request through the Vite proxy — the most deterministic
    // way to verify the proxy forwards to the correct Express server.
    // Does not depend on client boot behavior.
    const res = await request.get("/auth/token");

    expect(res.status()).toBe(200);

    const contentType = res.headers()["content-type"] ?? "";
    expect(contentType).toContain("application/json");

    const body = await res.json();
    expect(body).toHaveProperty("token");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  test("dashboard loads without SyntaxError on auth", async ({ page }) => {
    // Full page load — verifies the client successfully parses the
    // /auth/token response. If the proxy is wrong, this fails with
    // "Unexpected token '<'" in the console.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto("/");

    // Wait for the deterministic "auth resolved" signal — the client sets
    // window.__OCR_TOKEN__ once it has parsed the /auth/token response. We
    // deliberately do NOT fall back to `networkidle`: the dashboard holds a
    // persistent socket.io connection, so the network never goes idle and the
    // wait would race/time out (a former flake source). If the token never
    // appears, wait for the DOM-ready state so a real "/auth returned HTML"
    // failure still surfaces the SyntaxError below rather than hanging.
    await page
      .waitForFunction(() => window.__OCR_TOKEN__ !== undefined, {
        timeout: 10_000,
      })
      .catch(async () => {
        await page.waitForLoadState("domcontentloaded");
      });

    const syntaxErrors = consoleErrors.filter((e) =>
      e.includes("SyntaxError"),
    );
    expect(syntaxErrors).toHaveLength(0);
  });
});
