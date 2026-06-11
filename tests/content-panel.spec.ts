/**
 * E2E test for content panel loading.
 * Diagnoses why content doesn't appear.
 */
import { test, expect } from "@playwright/test";
import { login } from "./helpers";

const BASE_URL = process.env.BASE_URL || "https://crew.ominix.io";

test.use({ baseURL: BASE_URL });

test("content API returns data", async ({ page }) => {
  await login(page);

  // Wait for page to settle
  await page.waitForTimeout(3000);

  // Check what token is in localStorage
  const token = await page.evaluate(() => {
    return localStorage.getItem("octos_session_token") || localStorage.getItem("octos_auth_token") || "NONE";
  });
  console.log("Auth token:", token.substring(0, 20) + "...");

  // Intercept the content API call
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/my/content"),
      { timeout: 10000 }
    ).catch(() => null),
    // Also manually trigger a fetch to see what happens
    page.evaluate(async () => {
      const token = localStorage.getItem("octos_session_token") || localStorage.getItem("octos_auth_token");
      const resp = await fetch("/api/my/content?sort=newest&limit=10", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      console.log("Content API status:", resp.status);
      const text = await resp.text();
      console.log("Content API response:", text.substring(0, 500));
      return { status: resp.status, body: text.substring(0, 500) };
    }),
  ]);

  if (response) {
    console.log("Intercepted content API:", response.status(), response.url());
    const body = await response.text().catch(() => "failed to read body");
    console.log("Response body:", body.substring(0, 500));
  } else {
    console.log("No /api/my/content request intercepted within 10s");
  }

  // Check console for errors
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.text().includes("content")) {
      logs.push(`[${msg.type()}] ${msg.text()}`);
    }
  });

  await page.waitForTimeout(2000);
  console.log("Console logs:", logs);
});

test("content panel opens and shows items", async ({ page }) => {
  await login(page);
  await page.waitForTimeout(3000);

  const panelToggle = page.locator('button[title*="files panel"], button[title*="content"]');
  await expect(panelToggle).toBeVisible({ timeout: 5000 });

  await panelToggle.click();
  await page.waitForTimeout(2000);

  const contentHeader = page.locator('.shell-kicker:has-text("Session Files")');
  await expect(contentHeader).toBeVisible({ timeout: 3000 });

  const errorEl = page.locator('.text-red-400');
  const errorVisible = await errorEl.isVisible({ timeout: 1000 }).catch(() => false);
  expect(errorVisible).toBe(false);
});
