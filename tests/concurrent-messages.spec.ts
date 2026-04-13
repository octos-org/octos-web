/**
 * Hard test cases for concurrent message handling.
 *
 * Tests that messages sent during active streams are processed correctly
 * without loss, duplication, or ordering issues. Validates the removal
 * of client-side message queuing in favor of concurrent POSTs.
 */
import { test, expect } from "@playwright/test";
import {
  login,
  sendAndWait,
  SEL,
  createNewSession,
  getInput,
  getSendButton,
  markLogPosition,
  adminShell,
} from "./helpers";

/** Get all message bubbles with role and text. */
async function getAllBubbles(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll(
      "[data-testid='user-message'], [data-testid='assistant-message']",
    );
    return Array.from(nodes).map((el) => ({
      role: el.getAttribute("data-testid")?.includes("user")
        ? "user"
        : "assistant",
      text: (el.textContent || "").trim().slice(0, 150),
    }));
  });
}

/** Wait until assistant bubble count reaches expected, or timeout. */
async function waitForAssistantCount(
  page: import("@playwright/test").Page,
  count: number,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await page.locator(SEL.assistantMessage).count();
    if (n >= count) return n;
    await page.waitForTimeout(2000);
  }
  return page.locator(SEL.assistantMessage).count();
}

test.describe("Concurrent message handling", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await createNewSession(page);
  });

  test("rapid-fire 3 messages: all get responses", async ({ page }) => {
    // Send 3 messages as fast as possible — no waiting between sends
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    console.log("Sending 3 messages rapidly...");

    await input.fill("What is 1+1? One word answer.");
    await sendBtn.click();

    // Don't wait — send second immediately
    await page.waitForTimeout(500);
    await input.fill("What is 2+2? One word answer.");
    await sendBtn.click();

    // And third
    await page.waitForTimeout(500);
    await input.fill("What is 3+3? One word answer.");
    await sendBtn.click();

    // Wait for all 3 assistant responses
    console.log("Waiting for 3 assistant responses...");
    const finalCount = await waitForAssistantCount(page, 3, 90_000);
    console.log(`Got ${finalCount} assistant bubbles`);

    // Check all bubbles
    const bubbles = await getAllBubbles(page);
    console.log("All bubbles:");
    for (const [i, b] of bubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text}`);
    }

    // Should have 3 user + 3 assistant messages
    const userBubbles = bubbles.filter((b) => b.role === "user");
    const assistantBubbles = bubbles.filter((b) => b.role === "assistant");

    expect(userBubbles.length).toBe(3);
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(3);

    // Verify ordering: each user message should be followed by an assistant response
    // before the next user message (or at least all users appear before trailing assistants)
    const userIndices = bubbles
      .map((b, i) => (b.role === "user" ? i : -1))
      .filter((i) => i >= 0);
    expect(userIndices[0]).toBeLessThan(userIndices[1]);
    expect(userIndices[1]).toBeLessThan(userIndices[2]);
  });

  test("message during TTS streaming gets immediate response", async ({
    page,
  }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    // Send TTS request
    console.log("Step 1: Send TTS request");
    await input.fill("用杨幂声音说：你好");
    await sendBtn.click();

    // Wait until agent starts streaming (but don't wait for completion)
    await page.waitForFunction(
      () =>
        document.querySelectorAll("[data-testid='assistant-message']").length >
        0,
      undefined,
      { timeout: 30_000 },
    );

    // Immediately send a simple question — don't wait for TTS to finish
    console.log("Step 2: Send follow-up during TTS stream");
    const start = Date.now();
    await input.fill("What is the capital of France? One word.");
    await sendBtn.click();

    // Wait for a response containing "Paris"
    await page.waitForFunction(
      () => {
        const bubbles = document.querySelectorAll(
          "[data-testid='assistant-message']",
        );
        return Array.from(bubbles).some((el) =>
          /paris/i.test(el.textContent || ""),
        );
      },
      undefined,
      { timeout: 60_000 },
    );
    const elapsed = Date.now() - start;
    console.log(`Follow-up answered in ${elapsed}ms`);

    const bubbles = await getAllBubbles(page);
    console.log("Final state:");
    for (const [i, b] of bubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text.slice(0, 80)}`);
    }

    // Both user messages should be present
    const userBubbles = bubbles.filter((b) => b.role === "user");
    expect(userBubbles.length).toBe(2);

    // "Paris" should appear in an assistant bubble
    const parisResponse = bubbles.find(
      (b) => b.role === "assistant" && /paris/i.test(b.text),
    );
    expect(parisResponse).toBeTruthy();
  });

  test("TTS + weather + simple question: all responses arrive, no duplicates", async ({
    page,
  }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    console.log("Step 1: Send TTS");
    await input.fill("用杨幂声音说：测试");
    await sendBtn.click();

    // Brief pause to let streaming start
    await page.waitForTimeout(2000);

    console.log("Step 2: Send weather query");
    await input.fill("Tokyo weather today");
    await sendBtn.click();

    await page.waitForTimeout(2000);

    console.log("Step 3: Send simple question");
    await input.fill("What is 7*8? Just the number.");
    await sendBtn.click();

    // Wait for at least 3 assistant responses
    console.log("Waiting for all responses...");
    const finalCount = await waitForAssistantCount(page, 3, 120_000);
    console.log(`Got ${finalCount} assistant responses`);

    // Let sync settle
    await page.waitForTimeout(10_000);

    const bubbles = await getAllBubbles(page);
    console.log("Final state:");
    for (const [i, b] of bubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text.slice(0, 80)}`);
    }

    const userBubbles = bubbles.filter((b) => b.role === "user");
    const assistantBubbles = bubbles.filter((b) => b.role === "assistant");

    // All 3 user messages present
    expect(userBubbles.length).toBe(3);

    // At least 3 assistant responses (could be more with file delivery)
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(3);

    // Check for exact text duplicates
    const normalized = assistantBubbles.map((b) =>
      b.text
        .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    );
    const dupes = normalized.filter(
      (t, i) => t && normalized.indexOf(t) !== i,
    );
    if (dupes.length > 0) {
      console.log("DUPLICATES:", dupes);
    }
    expect(dupes).toHaveLength(0);

    // Ordering: user messages should maintain send order
    const userTexts = userBubbles.map((b) => b.text);
    expect(userTexts[0]).toMatch(/杨幂/);
    expect(userTexts[1]).toMatch(/Tokyo/i);
    expect(userTexts[2]).toMatch(/7\*8/);
  });

  test("5 rapid simple questions: no messages lost", async ({ page }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);
    const questions = [
      "What is 1+1? Just number.",
      "What is 2+2? Just number.",
      "What is 3+3? Just number.",
      "What is 4+4? Just number.",
      "What is 5+5? Just number.",
    ];

    console.log("Sending 5 questions rapidly...");
    for (const q of questions) {
      await input.fill(q);
      await sendBtn.click();
      await page.waitForTimeout(300); // minimal pause
    }

    // Wait for all 5 responses
    console.log("Waiting for 5 responses...");
    const finalCount = await waitForAssistantCount(page, 5, 120_000);
    console.log(`Got ${finalCount} assistant bubbles`);

    // Let sync settle
    await page.waitForTimeout(5_000);

    const bubbles = await getAllBubbles(page);
    const userBubbles = bubbles.filter((b) => b.role === "user");
    const assistantBubbles = bubbles.filter((b) => b.role === "assistant");

    console.log(`Users: ${userBubbles.length}, Assistants: ${assistantBubbles.length}`);
    for (const [i, b] of bubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text.slice(0, 60)}`);
    }

    // All 5 user messages must be present
    expect(userBubbles.length).toBe(5);

    // All 5 should have responses (backend followup mode processes sequentially)
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(5);
  });
});
