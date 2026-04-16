import { expect, test } from "@playwright/test";

import {
  SEL,
  createNewSession,
  getRenderedAudioAttachments,
  getRenderedThreadBubbles,
  login,
  sendAndWait,
} from "./helpers";

function findDuplicateAudioAttachments(
  attachments: { filename: string; path: string; text: string }[],
): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    const key = attachment.path || attachment.filename || attachment.text;
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));
}

test.describe("Live long-task smoke", () => {
  test.setTimeout(600_000);

  test.beforeEach(async ({ page }) => {
    await login(page);
    await createNewSession(page);
  });

  test("short TTS success renders exactly one audio attachment", async ({
    page,
  }) => {
    await sendAndWait(page, "用杨幂声音说：你好世界", {
      label: "live-short-tts-smoke",
      maxWait: 60_000,
    });

    let audioAttachments = [] as Awaited<
      ReturnType<typeof getRenderedAudioAttachments>
    >;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(3_000);
      audioAttachments = await getRenderedAudioAttachments(page);
      if (audioAttachments.length > 0) {
        break;
      }
    }

    const threadBubbles = await getRenderedThreadBubbles(page);
    const userBubbles = threadBubbles.filter((bubble) => bubble.role === "user");
    const duplicateAudio = findDuplicateAudioAttachments(audioAttachments);
    const firstAssistantIndex = threadBubbles.findIndex(
      (bubble) => bubble.role === "assistant",
    );

    expect(userBubbles).toHaveLength(1);
    expect(threadBubbles[0]?.role).toBe("user");
    expect(firstAssistantIndex).toBeGreaterThan(0);
    expect(duplicateAudio).toHaveLength(0);
    expect(audioAttachments).toHaveLength(1);
  });

  test("deep research survives reload without ghost turns", async ({ page }) => {
    const prompt =
      "Do a deep research on the latest Rust programming language developments in 2026. Run the pipeline directly, don't ask me to choose.";

    const result = await sendAndWait(page, prompt, {
      label: "live-deep-research",
      maxWait: 540_000,
      throwOnTimeout: false,
    });

    expect(result.responseLen).toBeGreaterThan(0);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await page.waitForTimeout(5_000);

    const threadBubbles = await getRenderedThreadBubbles(page);
    const userBubbles = threadBubbles.filter((bubble) => bubble.role === "user");
    const emptyAssistantBubbles = threadBubbles.filter(
      (bubble) =>
        bubble.role === "assistant" &&
        bubble.audioAttachments.length === 0 &&
        bubble.text.trim() === "",
    );

    expect(userBubbles.length).toBe(1);
    expect(userBubbles[0]?.text).toContain("latest Rust programming language");
    expect(emptyAssistantBubbles).toHaveLength(0);
    expect(threadBubbles[0]?.role).toBe("user");
  });

  test("research podcast delivers exactly one audio card after reload", async ({
    page,
  }) => {
    const prompt =
      "不要搜索，直接生成一个简短测试播客并把音频发回会话。脚本： [杨幂 - clone:yangmi, professional] 大家好。 [窦文涛 - clone:douwentao, professional] 这里是测试播客。 [杨幂 - clone:yangmi, professional] 今天只做一次快速验证。 [窦文涛 - clone:douwentao, professional] 感谢收听。";

    await sendAndWait(page, prompt, {
      label: "live-podcast-smoke",
      maxWait: 90_000,
    });

    let audioAttachments = [] as Awaited<
      ReturnType<typeof getRenderedAudioAttachments>
    >;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(3_000);
      audioAttachments = await getRenderedAudioAttachments(page);
      if (audioAttachments.length > 0) {
        break;
      }
    }

    expect(audioAttachments.length).toBeGreaterThan(0);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await page.waitForTimeout(8_000);

    const threadBubbles = await getRenderedThreadBubbles(page);
    audioAttachments = await getRenderedAudioAttachments(page);
    const duplicateAudio = findDuplicateAudioAttachments(audioAttachments);
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
});
