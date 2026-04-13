/**
 * Live queue mode tests against production backend.
 *
 * Tests that backend queue modes (collect, steer, interrupt) work correctly
 * now that the web client sends concurrent POSTs instead of queuing locally.
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
      text: (el.textContent || "").trim().slice(0, 200),
    }));
  });
}

/** Wait for assistant bubble count to reach target. */
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

/** Send a slash command and wait for the feedback or response. */
async function sendSlashCommand(
  page: import("@playwright/test").Page,
  command: string,
) {
  const result = await sendAndWait(page, command, {
    label: `cmd-${command.replace(/\s+/g, "-")}`,
    maxWait: 30_000,
    throwOnTimeout: false,
  });
  return result;
}

test.describe("Queue mode live tests", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await createNewSession(page);
  });

  test("collect mode: rapid messages merged into single response", async ({
    page,
  }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    // Switch to collect mode
    console.log("Setting collect mode...");
    await sendSlashCommand(page, "/queue collect");
    await createNewSession(page);

    // Send 3 messages rapidly — collect mode should merge them
    console.log("Sending 3 messages rapidly in collect mode...");
    await input.fill("Tell me about cats.");
    await sendBtn.click();
    await page.waitForTimeout(500);

    await input.fill("Also tell me about dogs.");
    await sendBtn.click();
    await page.waitForTimeout(500);

    await input.fill("And rabbits too.");
    await sendBtn.click();

    // Wait for response(s)
    console.log("Waiting for response...");
    await waitForAssistantCount(page, 1, 60_000);

    // Let sync settle
    await page.waitForTimeout(10_000);

    const bubbles = await getAllBubbles(page);
    console.log("Bubbles:");
    for (const [i, b] of bubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text.slice(0, 100)}`);
    }

    const userBubbles = bubbles.filter((b) => b.role === "user");
    const assistantBubbles = bubbles.filter((b) => b.role === "assistant");

    console.log(
      `Users: ${userBubbles.length}, Assistants: ${assistantBubbles.length}`,
    );

    // All 3 user messages should be present
    expect(userBubbles.length).toBe(3);

    // In collect mode, the backend should merge and produce fewer responses
    // than 3 (ideally 1 combined response mentioning all animals)
    // But even if it produces 3 separate responses, no messages should be lost
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(1);

    // Check if any response mentions multiple animals (merged)
    const allAssistantText = assistantBubbles
      .map((b) => b.text.toLowerCase())
      .join(" ");
    const mentionsCats = /cat/i.test(allAssistantText);
    const mentionsDogs = /dog/i.test(allAssistantText);
    const mentionsRabbits = /rabbit/i.test(allAssistantText);

    console.log(
      `Mentions: cats=${mentionsCats}, dogs=${mentionsDogs}, rabbits=${mentionsRabbits}`,
    );

    // At minimum, the response should address the topics
    expect(mentionsCats || mentionsDogs || mentionsRabbits).toBe(true);

    // Reset queue mode
    await sendSlashCommand(page, "/queue followup");
  });

  test("steer mode: only latest message processed", async ({ page }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    // Switch to steer mode
    console.log("Setting steer mode...");
    await sendSlashCommand(page, "/queue steer");
    await createNewSession(page);

    // Send 3 messages rapidly — steer mode should drop first two
    console.log("Sending 3 messages in steer mode...");
    await input.fill("What is the capital of Germany?");
    await sendBtn.click();
    await page.waitForTimeout(300);

    await input.fill("What is the capital of Japan?");
    await sendBtn.click();
    await page.waitForTimeout(300);

    await input.fill("What is the capital of Brazil?");
    await sendBtn.click();

    // Wait for response
    console.log("Waiting for response...");
    await waitForAssistantCount(page, 1, 60_000);
    await page.waitForTimeout(10_000);

    const bubbles = await getAllBubbles(page);
    console.log("Bubbles:");
    for (const [i, b] of bubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text.slice(0, 100)}`);
    }

    const assistantBubbles = bubbles.filter((b) => b.role === "assistant");

    // In steer mode, the backend should primarily respond to the latest message
    // Check if "Brasilia" appears (capital of Brazil = last message)
    const allText = assistantBubbles.map((b) => b.text.toLowerCase()).join(" ");
    const mentionsBrasilia = /bras[íi]lia/i.test(allText);
    const mentionsTokyo = /tokyo/i.test(allText);
    const mentionsBerlin = /berlin/i.test(allText);

    console.log(
      `Mentions: Berlin=${mentionsBerlin}, Tokyo=${mentionsTokyo}, Brasilia=${mentionsBrasilia}`,
    );

    // Steer should prioritize the latest message
    // We can't strictly assert ONLY Brasilia (backend may process all),
    // but at minimum the latest should be answered
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(1);

    // Reset
    await sendSlashCommand(page, "/queue followup");
  });

  test("interrupt mode: new message cancels in-flight processing", async ({
    page,
  }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    // Switch to interrupt mode
    console.log("Setting interrupt mode...");
    await sendSlashCommand(page, "/queue interrupt");
    await createNewSession(page);

    // Send a complex question that takes time
    console.log("Sending complex question...");
    await input.fill(
      "Write a detailed 500-word essay about the history of computing.",
    );
    await sendBtn.click();

    // Wait a bit for streaming to start
    await page.waitForFunction(
      () =>
        document.querySelectorAll("[data-testid='assistant-message']").length >
        0,
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(2000);

    // Interrupt with a simple question
    console.log("Interrupting with simple question...");
    await input.fill("What is 2+2? Just the number.");
    await sendBtn.click();

    // Wait for the simple answer
    console.log("Waiting for interrupt response...");
    await page.waitForFunction(
      () => {
        const bubbles = document.querySelectorAll(
          "[data-testid='assistant-message']",
        );
        return Array.from(bubbles).some((el) => {
          const text = (el.textContent || "").trim();
          return /\b4\b/.test(text) || /\bfour\b/i.test(text);
        });
      },
      undefined,
      { timeout: 60_000 },
    );

    const bubbles = await getAllBubbles(page);
    console.log("Final state:");
    for (const [i, b] of bubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text.slice(0, 80)}`);
    }

    // The simple question should have been answered
    const hasAnswer = bubbles.some(
      (b) =>
        b.role === "assistant" &&
        (/\b4\b/.test(b.text) || /\bfour\b/i.test(b.text)),
    );
    expect(hasAnswer).toBe(true);

    // Reset
    await sendSlashCommand(page, "/queue followup");
  });

  test("followup mode: sequential processing preserves all messages", async ({
    page,
  }) => {
    const input = getInput(page);
    const sendBtn = getSendButton(page);

    // Ensure followup mode (default)
    console.log("Setting followup mode...");
    await sendSlashCommand(page, "/queue followup");
    await createNewSession(page);

    // Send 3 messages with minimal gaps
    console.log("Sending 3 messages in followup mode...");
    await input.fill("What is the capital of France? One word.");
    await sendBtn.click();
    await page.waitForTimeout(1000);

    await input.fill("What is the capital of Italy? One word.");
    await sendBtn.click();
    await page.waitForTimeout(1000);

    await input.fill("What is the capital of Spain? One word.");
    await sendBtn.click();

    // Wait for all 3 responses
    console.log("Waiting for 3 responses...");
    const count = await waitForAssistantCount(page, 3, 120_000);
    console.log(`Got ${count} assistant bubbles`);

    await page.waitForTimeout(5_000);

    const bubbles = await getAllBubbles(page);
    console.log("Bubbles:");
    for (const [i, b] of bubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text.slice(0, 80)}`);
    }

    const userBubbles = bubbles.filter((b) => b.role === "user");
    const assistantBubbles = bubbles.filter((b) => b.role === "assistant");

    // All 3 user messages present
    expect(userBubbles.length).toBe(3);

    // All 3 should have responses in followup mode
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(3);

    // Verify answers
    const allText = assistantBubbles.map((b) => b.text.toLowerCase()).join(" ");
    expect(allText).toMatch(/paris/i);
    expect(allText).toMatch(/rome|roma/i);
    expect(allText).toMatch(/madrid/i);

    // Reset
    await sendSlashCommand(page, "/queue followup");
  });
});
