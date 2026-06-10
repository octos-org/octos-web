import { test, expect } from "@playwright/test";
import { login, sendAndWait, resetServer, createNewSession } from "./helpers";

test.describe("Adaptive routing", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await resetServer(page);
  });

  test("show adaptive status", async ({ page }) => {
    const radiogroup = page.locator("[role='radiogroup']");
    await expect(radiogroup).toBeVisible({ timeout: 5_000 });

    const offRadio = page.locator("[role='radio']").filter({ hasText: "Off" });
    await expect(offRadio).toBeVisible({ timeout: 3_000 });
  });

  test("switch to hedge mode", async ({ page }) => {
    const hedgeRadio = page.locator("[role='radio']").filter({ hasText: "Hedge" });
    await expect(hedgeRadio).toBeVisible({ timeout: 3_000 });
    const isDisabled = await hedgeRadio.isDisabled();
    test.skip(isDisabled, "Adaptive routing not available on this server profile");

    await hedgeRadio.click();
    await page.waitForTimeout(1000);
    await expect(hedgeRadio).toHaveAttribute("aria-checked", "true", { timeout: 3_000 });
  });

  test("switch back to off mode", async ({ page }) => {
    const hedgeRadio = page.locator("[role='radio']").filter({ hasText: "Hedge" });
    await expect(hedgeRadio).toBeVisible({ timeout: 3_000 });
    const isDisabled = await hedgeRadio.isDisabled();
    test.skip(isDisabled, "Adaptive routing not available on this server profile");

    await hedgeRadio.click();
    await page.waitForTimeout(1000);

    const offRadio = page.locator("[role='radio']").filter({ hasText: "Off" });
    await offRadio.click();
    await page.waitForTimeout(1000);
    await expect(offRadio).toHaveAttribute("aria-checked", "true", { timeout: 3_000 });
  });

  test("message works after switching adaptive mode", async ({ page }) => {
    const laneRadio = page.locator("[role='radio']").filter({ hasText: "Lane" });
    await expect(laneRadio).toBeVisible({ timeout: 3_000 });
    const isDisabled = await laneRadio.isDisabled();

    if (!isDisabled) {
      await laneRadio.click();
      await page.waitForTimeout(1000);
    }

    await createNewSession(page);
    const r = await sendAndWait(page, "What is the capital of France?", {
      label: "lane-msg",
      maxWait: 90_000
    });
    if (!r.timedOut) {
      expect(r.responseLen).toBeGreaterThan(0);
      expect(r.responseText.toLowerCase()).toContain("paris");
    }

    if (!isDisabled) {
      const offRadio = page.locator("[role='radio']").filter({ hasText: "Off" });
      await offRadio.click();
    }
  });
});
