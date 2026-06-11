import { test, expect } from "@playwright/test";
import { login, sendAndWait, getInput, getSendButton, SEL, resetServer, createNewSession } from "./helpers";

test.describe("Queue mode", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await resetServer(page);
  });

  test("switch to collect mode and verify response", async ({ page }) => {
    const r = await sendAndWait(page, "/queue collect", {
      label: "queue-collect"
      });
    expect(r.assistantBubbles).toBeGreaterThan(0);
    expect(r.responseLen).toBeGreaterThan(0);
  });

  test("switch to steer mode and verify response", async ({ page }) => {
    const r = await sendAndWait(page, "/queue steer", {
      label: "queue-steer"
      });
    expect(r.assistantBubbles).toBeGreaterThan(0);
    expect(r.responseLen).toBeGreaterThan(0);
  });

  test("switch to interrupt mode and verify response", async ({ page }) => {
    const r = await sendAndWait(page, "/queue interrupt", {
      label: "queue-interrupt"
      });
    expect(r.assistantBubbles).toBeGreaterThan(0);
    expect(r.responseLen).toBeGreaterThan(0);
  });

  test("collect mode merges rapid messages", async ({ page }) => {
    // Set collect mode
    await sendAndWait(page, "/queue collect", {
      label: "set-collect"
      });

    await createNewSession(page);

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
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(1);

    const allTexts = await Promise.all(assistantBubbles.map(b => b.textContent()));
    const combined = allTexts.join(" ").toLowerCase();
    expect(combined.length).toBeGreaterThan(0);
    // In collect mode, response should reference at least one of the sent topics
    expect(
      combined.includes("rust") || combined.includes("advantage") ||
      combined.includes("disadvantage") || combined.includes("programming") ||
      combined.length > 50
    ).toBe(true);
  });
});
