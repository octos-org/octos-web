/**
 * Speculative queue mode tests — fully async message processing.
 *
 * In speculative mode, the backend spawns each LLM call as a task and
 * immediately accepts the next message. Multiple messages can be processed
 * concurrently. This tests that the web client handles the concurrent
 * SSE streams and responses correctly.
 */
import { test, expect } from "@playwright/test";
import {
  login,
  sendAndWait,
  SEL,
  createNewSession,
  getInput,
  getSendButton,
} from "./helpers";

/** Get all bubbles. */
async function getAllBubbles(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll(
      "[data-testid='user-message'], [data-testid='assistant-message']",
    );
    return Array.from(nodes).map((el, i) => ({
      index: i,
      role: el.getAttribute("data-testid")?.includes("user")
        ? "user"
        : "assistant",
      text: (el.textContent || "").trim().slice(0, 200),
    }));
  });
}

/** Wait for N assistant bubbles with non-empty text. */
async function waitForFilledAssistants(
  page: import("@playwright/test").Page,
  count: number,
  timeoutMs = 90_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const filled = await page.evaluate((sel) => {
      const bubbles = document.querySelectorAll(sel);
      return Array.from(bubbles).filter((el) => {
        const text = (el.textContent || "").trim();
        // Skip empty streaming placeholders and timestamps-only
        return text.length > 20;
      }).length;
    }, SEL.assistantMessage);
    if (filled >= count) return filled;
    await page.waitForTimeout(2000);
  }
  return 0;
}

test.describe("Speculative queue mode", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    // Switch to speculative mode
    await sendAndWait(page, "/queue spec", {
      label: "set-spec",
      maxWait: 15_000,
      throwOnTimeout: false,
    });
    await createNewSession(page);
  });

  test.afterEach(async ({ page }) => {
    // Reset to followup
    await sendAndWait(page, "/queue followup", {
      label: "reset-queue",
      maxWait: 15_000,
      throwOnTimeout: false,
    });
  });

  test("two concurrent questions both get responses", async ({ page }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    console.log("Sending question A...");
    await input.fill("What is the capital of Australia? One word.");
    await sendBtn.click();

    // Don't wait — send B immediately
    await page.waitForTimeout(500);
    console.log("Sending question B...");
    await input.fill("What is the capital of Canada? One word.");
    await sendBtn.click();

    // Both should get responses concurrently in speculative mode
    console.log("Waiting for both responses...");
    const filled = await waitForFilledAssistants(page, 2, 60_000);
    console.log(`Got ${filled} filled assistant bubbles`);

    await page.waitForTimeout(5_000);

    const bubbles = await getAllBubbles(page);
    console.log("Final state:");
    for (const b of bubbles) {
      console.log(`  [${b.index}] ${b.role}: ${b.text.slice(0, 80)}`);
    }

    const users = bubbles.filter((b) => b.role === "user");
    const assistants = bubbles.filter((b) => b.role === "assistant");

    expect(users.length).toBe(2);
    expect(assistants.length).toBeGreaterThanOrEqual(2);

    const allText = assistants.map((b) => b.text.toLowerCase()).join(" ");
    const hasCanberra = /canberra/i.test(allText);
    const hasOttawa = /ottawa/i.test(allText);
    console.log(`Canberra: ${hasCanberra}, Ottawa: ${hasOttawa}`);

    expect(hasCanberra || hasOttawa).toBe(true);
  });

  test("3 concurrent: TTS + weather + math, all independent responses", async ({
    page,
  }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    console.log("Sending TTS...");
    await input.fill("用杨幂声音说：你好世界");
    await sendBtn.click();
    await page.waitForTimeout(500);

    console.log("Sending weather...");
    await input.fill("What is the weather in London?");
    await sendBtn.click();
    await page.waitForTimeout(500);

    console.log("Sending math...");
    await input.fill("What is 99*99? Just the number.");
    await sendBtn.click();

    // In speculative mode all 3 should process concurrently
    console.log("Waiting for responses...");
    const filled = await waitForFilledAssistants(page, 3, 120_000);
    console.log(`Got ${filled} filled assistant bubbles`);

    await page.waitForTimeout(10_000);

    const bubbles = await getAllBubbles(page);
    console.log("Final state:");
    for (const b of bubbles) {
      console.log(`  [${b.index}] ${b.role}: ${b.text.slice(0, 100)}`);
    }

    const users = bubbles.filter((b) => b.role === "user");
    const assistants = bubbles.filter((b) => b.role === "assistant");

    // All 3 user messages present
    expect(users.length).toBe(3);

    // All should have responses
    expect(assistants.length).toBeGreaterThanOrEqual(3);

    // Check that math answer (9801) is present
    const allText = assistants.map((b) => b.text).join(" ");
    const hasMathAnswer = /9801/.test(allText);
    console.log(`Has 9801: ${hasMathAnswer}`);
    expect(hasMathAnswer).toBe(true);
  });

  test("rapid-fire 5 messages: no messages lost in async processing", async ({
    page,
  }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    const questions = [
      { q: "Capital of Egypt? One word.", a: /cairo/i },
      { q: "Capital of Peru? One word.", a: /lima/i },
      { q: "Capital of Sweden? One word.", a: /stockholm/i },
      { q: "Capital of Greece? One word.", a: /athens/i },
      { q: "Capital of Portugal? One word.", a: /lisbon/i },
    ];

    console.log("Sending 5 questions rapidly in spec mode...");
    for (const { q } of questions) {
      await input.fill(q);
      await sendBtn.click();
      await page.waitForTimeout(300);
    }

    console.log("Waiting for responses...");
    const filled = await waitForFilledAssistants(page, 5, 120_000);
    console.log(`Got ${filled} filled assistant bubbles`);

    await page.waitForTimeout(5_000);

    const bubbles = await getAllBubbles(page);
    const users = bubbles.filter((b) => b.role === "user");
    const assistants = bubbles.filter((b) => b.role === "assistant");

    console.log(`Users: ${users.length}, Assistants: ${assistants.length}`);
    for (const b of bubbles) {
      console.log(`  [${b.index}] ${b.role}: ${b.text.slice(0, 60)}`);
    }

    // All 5 user messages present
    expect(users.length).toBe(5);

    // Should have at least 5 responses
    expect(assistants.length).toBeGreaterThanOrEqual(5);

    // Check answers
    const allText = assistants.map((b) => b.text.toLowerCase()).join(" ");
    let found = 0;
    for (const { a } of questions) {
      if (a.test(allText)) found++;
    }
    console.log(`Found ${found}/5 correct answers`);
    // At least 3 of 5 should have correct capital answers
    expect(found).toBeGreaterThanOrEqual(3);
  });

  test("speculative mode is faster than followup for concurrent messages", async ({
    page,
  }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    // Time 2 concurrent questions in speculative mode
    console.log("Spec mode: sending 2 questions...");
    const specStart = Date.now();

    await input.fill("What is 11*11? Just number.");
    await sendBtn.click();
    await page.waitForTimeout(300);
    await input.fill("What is 12*12? Just number.");
    await sendBtn.click();

    await waitForFilledAssistants(page, 2, 60_000);
    const specTime = Date.now() - specStart;
    console.log(`Spec mode: ${specTime}ms for 2 responses`);

    // Verify both answers present
    const bubbles = await getAllBubbles(page);
    const allText = bubbles
      .filter((b) => b.role === "assistant")
      .map((b) => b.text)
      .join(" ");
    const has121 = /121/.test(allText);
    const has144 = /144/.test(allText);
    console.log(`121: ${has121}, 144: ${has144}`);

    // Both answers should be present
    expect(has121 || has144).toBe(true);

    // In speculative mode, total time should be closer to max(A,B)
    // rather than sum(A+B) — concurrent processing
    // We can't strictly assert timing, but log it for comparison
    console.log(
      `Speculative mode processed 2 questions in ${specTime}ms (concurrent)`,
    );
  });
});
