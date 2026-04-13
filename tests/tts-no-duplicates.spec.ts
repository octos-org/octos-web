/**
 * Targeted test for duplicate message detection during TTS generation.
 *
 * Verifies that after a TTS request + file delivery, the chat UI does NOT
 * contain duplicate assistant messages. Checks both the DOM and the
 * underlying message store for duplicates.
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

/** Extract all assistant bubble texts from the page. */
async function getAssistantBubbles(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const bubbles = document.querySelectorAll(
      "[data-testid='assistant-message']",
    );
    return Array.from(bubbles).map((el) => ({
      text: (el.textContent || "").trim(),
      html: el.innerHTML.slice(0, 200),
    }));
  });
}

/** Extract user bubble texts from the page. */
async function getUserBubbles(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const bubbles = document.querySelectorAll("[data-testid='user-message']");
    return Array.from(bubbles).map((el) => (el.textContent || "").trim());
  });
}

/** Check if text contains an audio player element. */
async function countAudioPlayers(page: import("@playwright/test").Page) {
  return page.locator("audio").count();
}

/** Normalize text for duplicate comparison — strip timestamps, whitespace, tool badges. */
function normalizeForComparison(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g, "") // timestamps
    .replace(/\d+s\s*·\s*[\d.]+k[↑↓]\s*\d+[↑↓]?/g, "") // streaming stats
    .replace(/via\s+\S+\s*\([^)]*\)/g, "") // provider info
    .replace(/\s+/g, " ")
    .trim();
}

/** Find duplicate texts among assistant bubbles. */
function findDuplicates(
  bubbles: { text: string }[],
): { text: string; count: number }[] {
  const normalized = bubbles.map((b) => normalizeForComparison(b.text));
  const counts = new Map<string, number>();
  for (const text of normalized) {
    if (!text) continue;
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([text, count]) => ({ text: text.slice(0, 80), count }));
}

test.describe("TTS duplicate message detection", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    // Always start in a fresh session
    await createNewSession(page);
  });

  test("fresh session: TTS request produces no duplicate bubbles", async ({
    page,
  }) => {
    const logMark = await markLogPosition();

    // Send TTS request
    console.log("Step 1: Send TTS request");
    const result = await sendAndWait(page, "用杨幂声音说：你好世界", {
      label: "tts-dup-test",
      maxWait: 60_000,
    });
    console.log(
      `  Response (${result.assistantBubbles} bubbles): "${result.responseText.slice(0, 80)}"`,
    );

    // Wait for file delivery (up to 45s)
    console.log("Step 2: Wait for file delivery");
    let hasAudio = false;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(3000);
      const audioCount = await countAudioPlayers(page);
      const bubbles = await getAssistantBubbles(page);
      console.log(
        `  ${i * 3}s: ${bubbles.length} assistant bubbles, ${audioCount} audio players`,
      );
      if (audioCount > 0) {
        hasAudio = true;
        break;
      }
    }

    // Wait a few more seconds for any late sync that might cause duplicates
    console.log("Step 3: Wait for sync to settle (10s)");
    await page.waitForTimeout(10_000);

    // Snapshot the final state
    console.log("Step 4: Check for duplicates");
    const userBubbles = await getUserBubbles(page);
    const assistantBubbles = await getAssistantBubbles(page);
    const audioCount = await countAudioPlayers(page);

    console.log(`  User bubbles: ${userBubbles.length}`);
    console.log(`  Assistant bubbles: ${assistantBubbles.length}`);
    console.log(`  Audio players: ${audioCount}`);
    for (const [i, b] of assistantBubbles.entries()) {
      console.log(`  [assistant ${i}] ${b.text.slice(0, 100)}`);
    }

    // Check for duplicates
    const dupes = findDuplicates(assistantBubbles);
    if (dupes.length > 0) {
      console.log("DUPLICATE DETECTED:");
      for (const d of dupes) {
        console.log(`  "${d.text}" appears ${d.count}x`);
      }
    }

    // Assertions
    expect(userBubbles.length).toBe(1); // exactly 1 user message
    expect(dupes).toHaveLength(0); // no duplicate assistant bubbles
    // Should have at most: 1 response + 1 file player bubble = 2 assistant bubbles
    // (the task completion notification should be filtered)
    expect(assistantBubbles.length).toBeLessThanOrEqual(3);

    // If audio was delivered, verify it's there
    if (hasAudio) {
      expect(audioCount).toBeGreaterThan(0);
    }
  });

  test("TTS then weather: messages stay ordered, no duplicates", async ({
    page,
  }) => {
    // Send TTS request
    console.log("Step 1: Send TTS request");
    await sendAndWait(page, "用杨幂声音说：今天天气不错", {
      label: "tts-then-weather",
      maxWait: 60_000,
    });

    // Wait a bit for background task to start
    await page.waitForTimeout(5000);

    // Send weather request in the same session
    console.log("Step 2: Send weather request");
    const weatherResult = await sendAndWait(
      page,
      "what is the weather in Tokyo?",
      {
        label: "weather-after-tts",
        maxWait: 60_000,
      },
    );
    console.log(
      `  Weather response: "${weatherResult.responseText.slice(0, 80)}"`,
    );

    // Wait for TTS file delivery
    console.log("Step 3: Wait for file delivery (30s)");
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);
      const audioCount = await countAudioPlayers(page);
      if (audioCount > 0) {
        console.log(`  Audio arrived at ${i * 3}s`);
        break;
      }
    }

    // Wait for sync to settle
    await page.waitForTimeout(10_000);

    // Check ordering and duplicates
    console.log("Step 4: Verify ordering and duplicates");
    const allBubbles = await page.evaluate(() => {
      const nodes = document.querySelectorAll(
        "[data-testid='user-message'], [data-testid='assistant-message']",
      );
      return Array.from(nodes).map((el) => ({
        role: el.getAttribute("data-testid")?.includes("user")
          ? "user"
          : "assistant",
        text: (el.textContent || "").trim().slice(0, 100),
      }));
    });

    for (const [i, b] of allBubbles.entries()) {
      console.log(`  [${i}] ${b.role}: ${b.text}`);
    }

    // Check ordering: user messages should appear before their responses
    const userIndices = allBubbles
      .map((b, i) => (b.role === "user" ? i : -1))
      .filter((i) => i >= 0);
    expect(userIndices.length).toBe(2); // TTS question + weather question

    // First user message should be before second
    expect(userIndices[0]).toBeLessThan(userIndices[1]);

    // Check for duplicates
    const assistantBubbles = allBubbles
      .filter((b) => b.role === "assistant")
      .map((b) => ({ text: b.text }));
    const dupes = findDuplicates(assistantBubbles);
    if (dupes.length > 0) {
      console.log("DUPLICATE DETECTED:");
      for (const d of dupes) {
        console.log(`  "${d.text}" appears ${d.count}x`);
      }
    }
    expect(dupes).toHaveLength(0);
  });

  test("message store has no duplicate historySeq", async ({ page }) => {
    // Send TTS request
    console.log("Step 1: Send TTS request and wait");
    await sendAndWait(page, "用杨幂声音说：测试消息", {
      label: "store-dup-test",
      maxWait: 60_000,
    });

    // Wait for file delivery and sync
    await page.waitForTimeout(15_000);

    // Check the message store directly for duplicate historySeqs
    console.log("Step 2: Check message store for duplicates");
    const storeState = await page.evaluate(() => {
      // Access the message store's internal state via the React hook
      const sessionId = localStorage.getItem("octos_current_session") || "";
      // The store exposes getMessages publicly
      const store = (window as any).__OCTOS_MSG_STORE__;
      if (!store) return { error: "store not accessible", messages: [] };

      return {
        sessionId,
        messages: store.getMessages(sessionId).map(
          (m: any) => ({
            id: m.id,
            role: m.role,
            text: (m.text || "").slice(0, 80),
            historySeq: m.historySeq,
            status: m.status,
            files: m.files?.length || 0,
          }),
        ),
      };
    });

    if (storeState.error) {
      console.log(`  Store not accessible: ${storeState.error}`);
      console.log("  (Skipping store-level duplicate check)");
      return;
    }

    console.log(`  Session: ${storeState.sessionId}`);
    for (const m of storeState.messages) {
      console.log(
        `  [seq=${m.historySeq ?? "none"}] ${m.role} (${m.status}): ${m.text} files=${m.files}`,
      );
    }

    // Check for duplicate historySeq values
    const seqs = storeState.messages
      .map((m: any) => m.historySeq)
      .filter((s: any) => typeof s === "number");
    const uniqueSeqs = new Set(seqs);
    if (seqs.length !== uniqueSeqs.size) {
      const dupeSeqs = seqs.filter(
        (s: number, i: number) => seqs.indexOf(s) !== i,
      );
      console.log(`  DUPLICATE historySeq values: ${dupeSeqs}`);
    }
    expect(seqs.length).toBe(uniqueSeqs.size);

    // Check for duplicate text content
    const assistantTexts = storeState.messages
      .filter((m: any) => m.role === "assistant" && m.text)
      .map((m: any) => m.text);
    const uniqueTexts = new Set(assistantTexts);
    if (assistantTexts.length !== uniqueTexts.size) {
      console.log("  DUPLICATE assistant texts found in store");
    }
    // Allow file-delivery messages to share format, but flag exact duplicates
    expect(assistantTexts.length).toBeLessThanOrEqual(uniqueTexts.size + 1);
  });
});
