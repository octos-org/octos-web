import { test, expect } from "@playwright/test";
import { login } from "./helpers";

/**
 * Smoke tests for the /settings page.
 *
 * When the backend supports `/api/auth/me` and returns a full profile,
 * the sidebar shows all 9 tabs (including admin-only: Users, System,
 * Server) and each tab renders its settings content.
 *
 * When `/api/auth/me` returns 404 (older backends), the settings page
 * shows a "No profile available" placeholder with only 6 basic tabs.
 * Tests adapt to whichever state is present.
 */

const TIMEOUT = 10_000;

/** Navigate to /settings after login. */
async function goToSettings(page: import("@playwright/test").Page) {
  await login(page);
  await page.goto("/settings", { waitUntil: "networkidle" });
  await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
}

/** Click a sidebar tab button by its visible label. */
async function clickTab(page: import("@playwright/test").Page, label: string) {
  const tab = page.locator("aside button", { hasText: label }).first();
  await tab.click();
  await page.waitForTimeout(500);
}

/** Whether the settings page has a loaded profile (vs "No profile available"). */
async function hasProfile(page: import("@playwright/test").Page): Promise<boolean> {
  const noProfile = page.locator("text=No profile available").first();
  return !(await noProfile.isVisible({ timeout: 2_000 }).catch(() => false));
}

// ── Tests ───────────────────────────────────────────────────────

test.describe("Settings page — tab smoke tests", () => {
  test("all 9 tab buttons are visible", async ({ page }) => {
    await goToSettings(page);

    const baseTabs = ["Profile", "LLM", "Skills", "Channels", "Sandbox", "Tools"];
    const adminTabs = ["Users", "System", "Server"];
    const profileLoaded = await hasProfile(page);

    for (const label of baseTabs) {
      await expect(
        page.locator("aside button", { hasText: label }).first(),
      ).toBeVisible({ timeout: TIMEOUT });
    }

    if (profileLoaded) {
      for (const label of adminTabs) {
        await expect(
          page.locator("aside button", { hasText: label }).first(),
        ).toBeVisible({ timeout: TIMEOUT });
      }
    }
  });

  test("Profile tab renders profile info and gateway status", async ({
    page,
  }) => {
    await goToSettings(page);
    await clickTab(page, "Profile");

    const profileLoaded = await hasProfile(page);
    if (profileLoaded) {
      await expect(
        page.locator("h3", { hasText: "Profile Information" }),
      ).toBeVisible({ timeout: TIMEOUT });
      await expect(
        page.locator("text=Display Name").first(),
      ).toBeVisible({ timeout: TIMEOUT });
      await expect(
        page.locator("h3", { hasText: "Gateway Status" }),
      ).toBeVisible({ timeout: TIMEOUT });
    } else {
      await expect(
        page.locator("text=No profile available").first(),
      ).toBeVisible({ timeout: TIMEOUT });
    }
  });

  test("LLM tab renders provider selector and fallback section", async ({
    page,
  }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "LLM");
    await expect(
      page.locator("h3", { hasText: "LLM Configuration" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("select").filter({ hasText: "Select a provider..." }).first(),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "Fallback Models" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Skills tab shows Installed Skills and Octos Hub", async ({
    page,
  }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Skills");
    await expect(
      page.locator("h3", { hasText: "Installed Skills" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "Octos Hub" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Channels tab renders Add Channel button", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Channels");
    await expect(
      page.locator("button", { hasText: "Add Channel" }).first(),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Sandbox tab renders configuration section", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Sandbox");
    await expect(
      page.locator("h3", { hasText: "Sandbox Configuration" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("text=Enable Sandbox").first(),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Tools tab renders Web Search APIs section", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Tools");
    await expect(
      page.locator("h3", { hasText: "Web Search APIs" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("System tab shows Operator Overview (admin)", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "System");
    await expect(
      page.locator("h3", { hasText: "Operator Overview" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Server tab shows Deployment Mode (admin)", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Server");
    await expect(
      page.locator("h3", { hasText: "Server Info" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "Deployment Mode" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("tab switching changes content", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Profile");
    await expect(
      page.locator("h3", { hasText: "Profile Information" }),
    ).toBeVisible({ timeout: TIMEOUT });

    await clickTab(page, "LLM");
    await expect(
      page.locator("h3", { hasText: "Profile Information" }),
    ).toBeHidden({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "LLM Configuration" }),
    ).toBeVisible({ timeout: TIMEOUT });

    await clickTab(page, "Skills");
    await expect(
      page.locator("h3", { hasText: "LLM Configuration" }),
    ).toBeHidden({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "Installed Skills" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });
});
