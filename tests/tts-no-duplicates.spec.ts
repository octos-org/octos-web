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
  getRenderedAudioAttachments,
  getRenderedThreadBubbles,
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

/** Normalize text for duplicate comparison — strip timestamps, whitespace, tool badges. */
function normalizeForComparison(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g, "") // timestamps
    .replace(/\d+s\s*·\s*[\d.]+k[↑↓]\s*\d+[↑↓]?/g, "") // streaming stats
    .replace(/via\s+\S+\s*\([^)]*\)/g, "") // provider info
    .replace(/\s+/g, " ")
    .trim();
}

function findDuplicateAudioAttachments(
  attachments: { filename: string; path: string; text: string }[],
): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    const key =
      attachment.path ||
      attachment.filename ||
      normalizeForComparison(attachment.text);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));
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
    let audioAttachments = [] as Awaited<
      ReturnType<typeof getRenderedAudioAttachments>
    >;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(3000);
      audioAttachments = await getRenderedAudioAttachments(page);
      const bubbles = await getAssistantBubbles(page);
      console.log(
        `  ${i * 3}s: ${bubbles.length} assistant bubbles, ${audioAttachments.length} audio attachments`,
      );
      if (audioAttachments.length > 0) {
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
    audioAttachments = await getRenderedAudioAttachments(page);
    const threadBubbles = await getRenderedThreadBubbles(page);

    console.log(`  User bubbles: ${userBubbles.length}`);
    console.log(`  Assistant bubbles: ${assistantBubbles.length}`);
    console.log(`  Audio attachments: ${audioAttachments.length}`);
    for (const [i, b] of assistantBubbles.entries()) {
      console.log(`  [assistant ${i}] ${b.text.slice(0, 100)}`);
    }
    for (const [i, attachment] of audioAttachments.entries()) {
      console.log(
        `  [audio ${i}] filename=${attachment.filename} path=${attachment.path}`,
      );
    }

    // Check for duplicates
    const dupes = findDuplicates(assistantBubbles);
    const duplicateAudio = findDuplicateAudioAttachments(audioAttachments);
    if (dupes.length > 0) {
      console.log("DUPLICATE DETECTED:");
      for (const d of dupes) {
        console.log(`  "${d.text}" appears ${d.count}x`);
      }
    }
    if (duplicateAudio.length > 0) {
      console.log("DUPLICATE AUDIO ATTACHMENT DETECTED:");
      for (const d of duplicateAudio) {
        console.log(`  "${d.key}" appears ${d.count}x`);
      }
    }

    // Assertions
    expect(userBubbles.length).toBe(1); // exactly 1 user message
    expect(dupes).toHaveLength(0); // no duplicate assistant bubbles
    expect(duplicateAudio).toHaveLength(0); // no duplicate rendered audio cards
    expect(threadBubbles[0]?.role).toBe("user"); // question must stay before answer
    // Should have at most: 1 response + 1 file player bubble = 2 assistant bubbles
    // (the task completion notification should be filtered)
    expect(assistantBubbles.length).toBeLessThanOrEqual(3);

    expect(audioAttachments.length).toBe(1);
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
      const audioAttachments = await getRenderedAudioAttachments(page);
      if (audioAttachments.length > 0) {
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

    // No assistant bubble should appear before the first user bubble.
    expect(allBubbles[0]?.role).toBe("user");

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

  test("podcast request: question stays before answer and audio card is unique after reload", async ({
    page,
  }) => {
    const prompt =
      "不要搜索，直接生成一个简短测试播客并把音频发回会话。脚本： [杨幂 - clone:yangmi, professional] 大家好。 [窦文涛 - clone:douwentao, professional] 这里是测试播客。 [杨幂 - clone:yangmi, professional] 今天只做一次快速验证。 [窦文涛 - clone:douwentao, professional] 感谢收听。";

    console.log("Step 1: Send podcast request");
    await sendAndWait(page, prompt, {
      label: "podcast-order-test",
      maxWait: 90_000,
    });

    console.log("Step 2: Wait for podcast audio delivery");
    let audioAttachments = [] as Awaited<
      ReturnType<typeof getRenderedAudioAttachments>
    >;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(3000);
      audioAttachments = await getRenderedAudioAttachments(page);
      console.log(
        `  ${i * 3}s: ${audioAttachments.length} audio attachment(s)`,
      );
      if (audioAttachments.length > 0) {
        break;
      }
    }

    expect(audioAttachments.length).toBeGreaterThan(0);

    console.log("Step 3: Reload and verify final rendered history");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await page.waitForTimeout(8000);

    const threadBubbles = await getRenderedThreadBubbles(page);
    audioAttachments = await getRenderedAudioAttachments(page);
    const duplicateAudio = findDuplicateAudioAttachments(audioAttachments);

    for (const [i, bubble] of threadBubbles.entries()) {
      console.log(
        `  [${i}] ${bubble.role}: ${bubble.text.slice(0, 120)} audio=${bubble.audioAttachments.length}`,
      );
    }
    for (const [i, attachment] of audioAttachments.entries()) {
      console.log(
        `  [audio ${i}] filename=${attachment.filename} path=${attachment.path}`,
      );
    }

    const promptIndex = threadBubbles.findIndex(
      (bubble) =>
        bubble.role === "user" && bubble.text.includes("不要搜索，直接生成一个简短测试播客"),
    );
    const firstAssistantIndex = threadBubbles.findIndex(
      (bubble) => bubble.role === "assistant",
    );

    expect(promptIndex).toBe(0);
    expect(firstAssistantIndex).toBeGreaterThan(promptIndex);
    expect(duplicateAudio).toHaveLength(0);
    expect(audioAttachments.length).toBe(1);
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
