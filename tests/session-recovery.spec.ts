import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  login,
  sendAndWait,
  createNewSession,
  getInput,
  getSendButton,
  SEL,
  countAssistantBubbles,
  countUserBubbles,
  getChatThreadText,
  getRenderedAudioAttachments,
  getRenderedThreadBubbles,
} from "./helpers";

async function resetChat(page: Page) {
  await login(page);
  await createNewSession(page);
}

async function openAuthedChat(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await resetChat(page);
  return { context, page };
}

async function waitForRecoveredTurn(page: Page, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const assistantCount = await page.locator(SEL.assistantMessage).count();
    const userCount = await page.locator(SEL.userMessage).count();
    const streaming = await page
      .locator(SEL.cancelButton)
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    const text =
      assistantCount > 0
        ? ((await page
            .locator(SEL.assistantMessage)
            .last()
            .textContent()
            .catch(() => "")) || "").trim()
        : "";

    if (userCount === 1 && assistantCount === 1 && !streaming && text) {
      return text;
    }

    await page.waitForTimeout(2_000);
  }

  throw new Error("Timed out waiting for the recovered turn to settle");
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
    page,
  }) => {
    await resetChat(page);

    const marker = `RECONNECT-${Date.now()}`;
    await getInput(page).fill(
      `Write exactly 12 numbered bullets about reconnect storms and session recovery. Each bullet must be one short sentence. Include ${marker} exactly once in bullet 12. Keep the total answer between 220 and 320 words so it streams long enough to survive two reloads without turning into an unbounded memo.`,
    );
    await getSendButton(page).click();

    await page.waitForFunction(
      () =>
        document.querySelectorAll("[data-testid='assistant-message']").length >
          0 &&
        document.querySelector("[data-testid='cancel-button']") !== null,
      undefined,
      { timeout: 30_000 },
    );

    await page.waitForTimeout(2_500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });

    const finalText = await waitForRecoveredTurn(page);
    expect(finalText.length).toBeGreaterThan(0);
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBe(1);

    const threadText = await getChatThreadText(page);
    expect(threadText).toContain(marker);
  });

  test("concurrent live sessions stay isolated after independent reloads", async ({
    browser,
  }) => {
    const first = await openAuthedChat(browser);
    const second = await openAuthedChat(browser);

    try {
      const alpha = `ALPHA-${Date.now()}`;
      const beta = `BRAVO-${Date.now()}`;

      const [alphaResult, betaResult] = await Promise.all([
        sendAndWait(first.page, `Reply with exactly: ${alpha}`, {
          label: "alpha",
          maxWait: 60_000,
        }),
        sendAndWait(second.page, `Reply with exactly: ${beta}`, {
          label: "beta",
          maxWait: 60_000,
        }),
      ]);

      expect(alphaResult.responseLen).toBeGreaterThan(0);
      expect(betaResult.responseLen).toBeGreaterThan(0);

      await Promise.all([
        first.page.reload({ waitUntil: "domcontentloaded" }),
        second.page.reload({ waitUntil: "domcontentloaded" }),
      ]);
      await Promise.all([
        first.page.waitForSelector(SEL.chatInput, { timeout: 15_000 }),
        second.page.waitForSelector(SEL.chatInput, { timeout: 15_000 }),
      ]);
      await Promise.all([
        first.page.waitForTimeout(3_000),
        second.page.waitForTimeout(3_000),
      ]);

      const alphaText = await getChatThreadText(first.page);
      const betaText = await getChatThreadText(second.page);

      expect(alphaText).toContain(alpha);
      expect(alphaText).not.toContain(beta);
      expect(betaText).toContain(beta);
      expect(betaText).not.toContain(alpha);

      expect(await countUserBubbles(first.page)).toBe(1);
      expect(await countAssistantBubbles(first.page)).toBe(1);
      expect(await countUserBubbles(second.page)).toBe(1);
      expect(await countAssistantBubbles(second.page)).toBe(1);
    } finally {
      await Promise.all([first.context.close(), second.context.close()]);
    }
  });

  test("switching back to an earlier session after reload restores its history", async ({
    page,
  }) => {
    await resetChat(page);

    const alpha = `ALPHA-${Date.now()}`;
    const beta = `BRAVO-${Date.now()}`;

    const first = await sendAndWait(page, `Reply with exactly: ${alpha}`, {
      label: "child-alpha",
      maxWait: 60_000,
    });
    expect(first.responseLen).toBeGreaterThan(0);
    await page.waitForTimeout(2_000);

    const firstSessionId = await page
      .locator("[data-active='true']")
      .first()
      .getAttribute("data-session-id");
    expect(firstSessionId).toBeTruthy();

    await createNewSession(page);
    const second = await sendAndWait(page, `Reply with exactly: ${beta}`, {
      label: "child-beta",
      maxWait: 60_000,
    });
    expect(second.responseLen).toBeGreaterThan(0);
    await page.waitForTimeout(2_000);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await page.waitForTimeout(3_000);

    const currentText = await getChatThreadText(page);
    expect(currentText).toContain(beta);
    expect(currentText).not.toContain(alpha);
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBe(1);

    const firstSessionButton = page.locator(
      `[data-session-id="${firstSessionId}"] [data-testid="session-switch-button"]`,
    );
    await firstSessionButton.waitFor({ state: "visible", timeout: 15_000 });
    await firstSessionButton.click();
    await page.waitForTimeout(3_000);

    const restoredText = await getChatThreadText(page);
    expect(restoredText).toContain(alpha);
    expect(restoredText).not.toContain(beta);
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBe(1);
  });

  test("reloading during deferred artifact delivery preserves one recovered turn", async ({
    page,
  }) => {
    await resetChat(page);

    const prompt =
      "不要搜索，直接生成一个简短测试播客并把音频发回会话。脚本： [杨幂 - clone:yangmi, professional] 大家好。 [窦文涛 - clone:douwentao, professional] 这里是恢复测试。 [杨幂 - clone:yangmi, professional] 这次重点验证刷新后的持久化。 [窦文涛 - clone:douwentao, professional] 感谢收听。";

    const result = await sendAndWait(page, prompt, {
      label: "phase3-podcast-recovery",
      maxWait: 90_000,
    });
    expect(result.responseLen).toBeGreaterThan(0);
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
