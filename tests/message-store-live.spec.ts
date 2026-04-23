import { expect, test, type Page } from "@playwright/test";
import {
  SEL,
  createNewSession,
  getChatThreadText,
  login,
  sendAndWait,
} from "./helpers";

test.skip(
  process.env.LIVE_MESSAGE_STORE_GATE !== "1",
  "Set LIVE_MESSAGE_STORE_GATE=1 to run this live validation gate.",
);

async function activeSessionId(page: Page): Promise<string> {
  const id = await page.evaluate(() => localStorage.getItem("octos_current_session"));
  expect(id).toBeTruthy();
  return id!;
}

async function switchToSessionId(page: Page, sessionId: string): Promise<void> {
  await expect(page.locator(`[data-session-id="${sessionId}"]`)).toBeVisible({
    timeout: 30_000,
  });
  await page
    .locator(`[data-session-id="${sessionId}"] [data-testid="session-switch-button"]`)
    .click();
  await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
}

async function waitForTaskAnchor(page: Page, timeoutMs = 180_000): Promise<string> {
  await expect(page.getByTestId("task-anchor-message").first()).toBeVisible({
    timeout: timeoutMs,
  });
  const taskId = await page
    .getByTestId("task-anchor-message")
    .first()
    .getAttribute("data-task-id");
  expect(taskId).toBeTruthy();
  return taskId!;
}

test.describe("Live message-store gate", () => {
  test.setTimeout(600_000);

  test.beforeEach(async ({ page }) => {
    await login(page);
    await createNewSession(page);
  });

  test("normal chat does not render a background task bubble", async ({ page }) => {
    const marker = `NORMAL_CHAT_SCOPE_${Date.now()}`;

    await sendAndWait(page, `Reply briefly to this normal chat marker: ${marker}`, {
      label: "live-normal-chat-scope",
      maxWait: 90_000,
    });

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(0);
    await expect(page.getByTestId("assistant-message").last()).toHaveAttribute(
      "data-message-type",
      "assistant",
    );
    expect(await getChatThreadText(page)).toContain(marker);
  });

  test("deep research task anchor stays scoped across session switches", async ({
    page,
  }) => {
    const originMarker = `LIVE_DEEP_RESEARCH_ORIGIN_${Date.now()}`;
    const otherMarker = `LIVE_NORMAL_OTHER_${Date.now()}`;
    const originSessionId = await activeSessionId(page);

    await sendAndWait(
      page,
      `Do a deep research task for ${originMarker}. Run the pipeline directly and keep it concise.`,
      {
        label: "live-deep-research-scope",
        maxWait: 180_000,
        throwOnTimeout: false,
      },
    );
    const taskId = await waitForTaskAnchor(page);

    await createNewSession(page);
    const otherSessionId = await activeSessionId(page);
    expect(otherSessionId).not.toBe(originSessionId);

    await sendAndWait(page, `Reply briefly to this normal chat marker: ${otherMarker}`, {
      label: "live-other-session-normal",
      maxWait: 90_000,
    });

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(0);
    let threadText = await getChatThreadText(page);
    expect(threadText).toContain(otherMarker);
    expect(threadText).not.toContain(originMarker);

    await switchToSessionId(page, originSessionId);

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-task-id",
      taskId,
    );
    threadText = await getChatThreadText(page);
    expect(threadText).toContain(originMarker);
    expect(threadText).not.toContain(otherMarker);
  });
});
