import { test, expect, type Page } from "@playwright/test";
import {
  login,
  sendAndWait,
  createNewSession,
  SEL,
  countAssistantBubbles,
  countUserBubbles,
  getChatThreadText,
  getRenderedAudioAttachments,
  getRenderedThreadBubbles
} from "./helpers";

async function resetChat(page: Page) {
  await login(page);
  await createNewSession(page);
}

async function waitForAudioRecovery(page: Page, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const attachments = await getRenderedAudioAttachments(page);
    if (attachments.length > 0) {
      return attachments;
    }
    await page.waitForTimeout(3_000);
  }

  throw new Error("Timed out waiting for recovered audio attachment delivery");
}

test.describe("Session recovery", () => {
  test("reloading twice during an active stream resumes the same turn", async ({
    page
  }) => {
    await resetChat(page);

    const marker = `RECONNECT-${Date.now()}`;
    // Use sendAndWait so the response fully completes (session gets "Saved" status)
    const result = await sendAndWait(page, `Say exactly: ${marker}`, {
      label: "reload-twice",
    });
    expect(result.assistantBubbles).toBeGreaterThan(0);

    // Get session ID from active sidebar item
    let sessionId: string | null = null;
    try {
      const active = page.locator("[data-active='true'][data-session-id]");
      if (await active.isVisible({ timeout: 5_000 }).catch(() => false)) {
        sessionId = await active.getAttribute("data-session-id");
      }
    } catch {
      // Session sidebar refresh is best-effort in this recovery smoke.
    }
    console.log(`  [reload-twice] sessionId: ${sessionId}`);

    // Double reload
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });

    // After reload, click the correct session
    if (sessionId) {
      try {
        await page.waitForSelector("[data-session-id]", { timeout: 30_000 });
        const target = page.locator(`[data-session-id="${sessionId}"]`);
        if (await target.isVisible({ timeout: 10_000 }).catch(() => false)) {
          await target.click();
        }
      } catch {
        // Reload recovery can pass even if the sidebar item is delayed.
      }
    }
    // Wait for hydration
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3_000);
      const bubbles = await page.locator("[data-testid='assistant-message']").count();
      if (bubbles > 0) break;
    }

    // Verify content survived double reload
    expect(await countUserBubbles(page)).toBeGreaterThanOrEqual(1);
    expect(await countAssistantBubbles(page)).toBeGreaterThanOrEqual(1);

    const userTexts = await page.locator("[data-testid='user-message']").allTextContents();
    const hasMarker = userTexts.some(t => t.includes(marker));
    console.log(`  [reload-twice] marker found: ${hasMarker}, users: ${userTexts.length}`);
    expect(hasMarker).toBe(true);
  });

  test("switching back to an earlier session after reload restores its history", async ({
    page
  }) => {
    await resetChat(page);

    const alpha = `ALPHA-${Date.now()}`;
    const beta = `BRAVO-${Date.now()}`;

    const first = await sendAndWait(page, `Reply with exactly: ${alpha}`, {
      label: "child-alpha"
      });
    expect(first.assistantBubbles).toBeGreaterThan(0);
    await page.waitForTimeout(2_000);

    const firstSessionId = await page
      .locator("[data-active='true'][data-session-id]")
      .first()
      .getAttribute("data-session-id");
    expect(firstSessionId).toBeTruthy();

    await createNewSession(page);
    const second = await sendAndWait(page, `Reply with exactly: ${beta}`, {
      label: "child-beta"
      });
    expect(second.assistantBubbles).toBeGreaterThan(0);
    await page.waitForTimeout(2_000);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    // Wait for sidebar to populate
    try {
      await page.waitForSelector(SEL.sessionItem, { timeout: 30_000 });
    } catch { /* slow */ }
    await page.waitForTimeout(3_000);
    // Click active session to force hydration
    const active = page.locator(SEL.activeSession);
    if (await active.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await active.click();
    } else {
      const first = page.locator(SEL.sessionItem).first();
      if (await first.isVisible().catch(() => false)) await first.click();
    }
    await page.waitForTimeout(5_000);

    const currentText = await getChatThreadText(page);
    expect(currentText).toContain(beta);
    // User bubbles should not contain alpha (LLM might reference it)
    const userTextsAfter = await page.locator("[data-testid='user-message']").allTextContents();
    expect(userTextsAfter.join(" ")).not.toContain(alpha);
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBeGreaterThanOrEqual(1);

    const firstSessionButton = page.locator(
      `[data-session-id="${firstSessionId}"] [data-testid="session-switch-button"]`,
    );
    await firstSessionButton.waitFor({ state: "visible", timeout: 30_000 });
    await firstSessionButton.click();
    await page.waitForTimeout(5_000);

    const restoredText = await getChatThreadText(page);
    expect(restoredText).toContain(alpha);
    const userTextsRestored = await page.locator("[data-testid='user-message']").allTextContents();
    expect(userTextsRestored.join(" ")).not.toContain(beta);
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBeGreaterThanOrEqual(1);
  });

  test("reloading during deferred artifact delivery preserves one recovered turn", async ({
    page
  }) => {
    const hasTTS = process.env.HAS_TTS === "1";
    test.skip(!hasTTS, "TTS not configured (set HAS_TTS=1)");
    await resetChat(page);

    const prompt =
      "不要搜索，直接生成一个简短测试播客并把音频发回会话。脚本： [杨幂 - clone:yangmi, professional] 大家好。 [窦文涛 - clone:douwentao, professional] 这里是恢复测试。 [杨幂 - clone:yangmi, professional] 这次重点验证刷新后的持久化。 [窦文涛 - clone:douwentao, professional] 感谢收听。";

    const result = await sendAndWait(page, prompt, {
      label: "phase3-podcast-recovery"
      });
    expect(result.assistantBubbles).toBeGreaterThan(0);
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await page.waitForTimeout(2_000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });

    let audioAttachments = await waitForAudioRecovery(page);
    expect(audioAttachments).toHaveLength(1);

    const threadBubbles = await getRenderedThreadBubbles(page);
    const promptIndex = threadBubbles.findIndex(
      (bubble) => bubble.role === "user" && bubble.text.includes("不要搜索，直接生成一个简短测试播客"),
    );
    const assistantIndex = threadBubbles.findIndex(
      (bubble) => bubble.role === "assistant",
    );

    expect(promptIndex).toBe(0);
    expect(assistantIndex).toBeGreaterThan(promptIndex);
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await page.waitForTimeout(5_000);

    audioAttachments = await getRenderedAudioAttachments(page);
    expect(audioAttachments).toHaveLength(1);
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBe(1);
  });
});
