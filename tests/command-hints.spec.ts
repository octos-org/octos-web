import { test, expect } from "@playwright/test";
import { login, getInput, SEL } from "./helpers";

test.describe("Command hints UI", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("typing / shows command hints", async ({ page }) => {
    const input = getInput(page);
    await input.fill("/");

    // Command hints should appear
    const hints = page.locator(SEL.cmdHints);
    await expect(hints).toBeVisible({ timeout: 3000 });

    // Should show all commands
    const buttons = hints.locator("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(3); // /new, /clear, /delete at minimum
  });

  test("typing /q filters to matching commands", async ({ page }) => {
    const input = getInput(page);
    await input.fill("/q");

    const hints = page.locator(SEL.cmdHints);
    await expect(hints).toBeVisible({ timeout: 3000 });

    // Should show /queue
    const text = await hints.textContent();
    expect(text).toContain("/queue");
  });

  test("hints disappear when input is cleared", async ({ page }) => {
    const input = getInput(page);

    // Show hints
    await input.fill("/");
    await expect(page.locator(SEL.cmdHints)).toBeVisible({ timeout: 3000 });

    // Clear input
    await input.fill("");
    await expect(page.locator(SEL.cmdHints)).not.toBeVisible({ timeout: 3000 });
  });

  test("/help shows feedback message", async ({ page }) => {
    const input = getInput(page);
    const sendBtn = page.locator(SEL.sendButton);

    await input.fill("/help");
    await sendBtn.click();

    // Feedback should appear
    const feedback = page.locator(SEL.cmdFeedback);
    await expect(feedback).toBeVisible({ timeout: 3000 });

    const text = await feedback.textContent();
    expect(text).toContain("/new");
    expect(text).toContain("/queue");
  });
});
