import { test, expect } from "@playwright/test";
import { login, sendAndWait, createNewSession, SEL } from "./helpers";

test.describe("Error recovery", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("multi-turn conversation maintains bubble count", async ({ page }) => {
    const r1 = await sendAndWait(page, "Say hello", {
      label: "turn-1",
      maxWait: 60_000,
    });
    expect(r1.responseLen).toBeGreaterThan(0);
    expect(r1.userBubbles).toBe(1);
    expect(r1.assistantBubbles).toBe(1);

    const r2 = await sendAndWait(page, "Now say goodbye", {
      label: "turn-2",
      maxWait: 60_000,
    });
    expect(r2.responseLen).toBeGreaterThan(0);
    expect(r2.userBubbles).toBe(2);
    expect(r2.assistantBubbles).toBe(2);
    expect(r2.totalBubbles).toBe(4);
  });

  test("cancel during processing then new session works", async ({ page }) => {
    // Start a long operation
    const input = page.locator(SEL.chatInput).first();
    const sendBtn = page.locator(SEL.sendButton).first();

    await input.fill(
      "Write a very detailed 5000-word essay about the history of computing",
    );
    await sendBtn.click();

    // Wait for streaming to start
    await page.waitForTimeout(5000);

    // Click cancel if visible
    const cancelBtn = page.locator(SEL.cancelButton);
    if (await cancelBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cancelBtn.click();
      await page.waitForTimeout(2000);
    }

    // Start a fresh session to avoid stale state after cancel
    await createNewSession(page);

    // Send a new message in clean session — should work
    const r = await sendAndWait(page, "What is 1 + 1?", {
      label: "after-cancel",
      maxWait: 60_000,
    });
    expect(r.responseLen).toBeGreaterThan(0);
  });
});
