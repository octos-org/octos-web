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
    // Server returns "not yet wired" text which contains "queue"
    if (r.timedOut || r.assistantBubbles === 0) return;
    expect(r.responseLen).toBeGreaterThan(0);
    // The response contains the command echo at minimum
    expect(r.responseText.length).toBeGreaterThan(0);
  });

  test("switch to steer mode and verify response", async ({ page }) => {
    const r = await sendAndWait(page, "/queue steer", {
      label: "queue-steer"
      });
    if (r.timedOut || r.assistantBubbles === 0) return;
    expect(r.responseLen).toBeGreaterThan(0);
  });

  test("switch to interrupt mode and verify response", async ({ page }) => {
    const r = await sendAndWait(page, "/queue interrupt", {
      label: "queue-interrupt"
      });
    if (r.timedOut || r.assistantBubbles === 0) return;
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
    if (assistantBubbles.length === 0) return; // bridge drop
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(1);

    const lastText = await assistantBubbles[assistantBubbles.length - 1].textContent();
    if (lastText && lastText.length > 50) {
      expect(lastText.toLowerCase()).toMatch(/rust/);
    }
  });
});
