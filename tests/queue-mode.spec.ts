import { test, expect } from "@playwright/test";
import { login, sendAndWait, getInput, getSendButton, SEL, resetServer } from "./helpers";

test.describe("Queue mode", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await resetServer(page);
  });

  test("switch to collect mode and verify response", async ({ page }) => {
    const r = await sendAndWait(page, "/queue collect", {
      label: "queue-collect",
      maxWait: 30_000,
    });
    expect(r.responseLen).toBeGreaterThan(0);
    expect(r.responseText.toLowerCase()).toMatch(/collect|queue/);
  });

  test("switch to steer mode and verify response", async ({ page }) => {
    const r = await sendAndWait(page, "/queue steer", {
      label: "queue-steer",
      maxWait: 30_000,
    });
    expect(r.responseLen).toBeGreaterThan(0);
    expect(r.responseText.toLowerCase()).toMatch(/steer|queue/);
  });

  test("switch to interrupt mode and verify response", async ({ page }) => {
    const r = await sendAndWait(page, "/queue interrupt", {
      label: "queue-interrupt",
      maxWait: 30_000,
    });
    expect(r.responseLen).toBeGreaterThan(0);
    expect(r.responseText.toLowerCase()).toMatch(/interrupt|queue/);
  });

  test("collect mode merges rapid messages", async ({ page }) => {
    // Set collect mode
    await sendAndWait(page, "/queue collect", {
      label: "set-collect",
      maxWait: 30_000,
    });

    // Send two messages rapidly
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    await input.fill("First point: advantages of Rust");
    await sendBtn.click();
    await page.waitForTimeout(500);

    await input.fill("Second point: disadvantages of Rust");
    await sendBtn.click();

    // Wait for response to stabilize
    await page.waitForTimeout(3000);
    let stableCount = 0;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(3000);
      const streaming = await page
        .locator(SEL.cancelButton)
        .isVisible()
        .catch(() => false);
      if (!streaming) {
        stableCount++;
        if (stableCount >= 2) break;
      } else {
        stableCount = 0;
      }
    }

    // In collect mode, responses should reference Rust
    const assistantBubbles = await page.locator(SEL.assistantMessage).all();
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(2);

    const lastText = await assistantBubbles[assistantBubbles.length - 1].textContent();
    expect(lastText?.toLowerCase()).toMatch(/rust/);
  });
});
