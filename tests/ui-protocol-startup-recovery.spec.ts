import { expect, test } from "@playwright/test";

import {
  createUiProtocolHarnessControl,
  login,
  SEL,
  type UiProtocolHarnessControl,
} from "./helpers";

function methodCount(
  control: UiProtocolHarnessControl,
  method: string,
): number {
  return control.sentMethods.filter((entry) => entry === method).length;
}

test.describe("UI Protocol startup failure recovery", () => {
  test("Chat keeps one explicit failed ghost and Retry opens a fresh socket", async ({
    page,
  }) => {
    const uiProtocol = createUiProtocolHarnessControl(true);
    await login(page, { uiProtocol });

    const text = "recover this turn after the transport is restored";
    await page.locator(SEL.chatInput).fill(text);
    await page.locator(SEL.sendButton).click();

    const ghost = page.locator("[data-testid='ghost-bubble']");
    await expect(ghost).toHaveAttribute("data-ghost-state", "failed");
    await expect(
      ghost.locator("[data-testid='ghost-bubble-error']"),
    ).toContainText(
      "Octos Core closed the UI Protocol connection before it became ready",
    );
    await expect(
      page.locator("[data-testid='assistant-message']"),
    ).toHaveCount(0);
    await expect(
      page.locator("[data-testid='thinking-indicator']"),
    ).toHaveCount(0);
    expect(methodCount(uiProtocol, "turn/start")).toBe(0);

    const attemptsBeforeRetry = uiProtocol.socketAttempts;
    uiProtocol.failStartup = false;
    await ghost.locator("[data-testid='ghost-bubble-retry']").click();

    await expect
      .poll(() => uiProtocol.socketAttempts)
      .toBeGreaterThan(attemptsBeforeRetry);
    await expect
      .poll(() => methodCount(uiProtocol, "turn/start"))
      .toBe(1);
    await expect(ghost).toHaveCount(0);
    await expect(
      page.locator("[data-testid='user-message']", { hasText: text }),
    ).toHaveCount(1);
    await expect(
      page.locator("[data-testid='assistant-message']", {
        hasText: `Mock response: ${text}`,
      }),
    ).toHaveCount(1);
  });

  test("Settings Retry recovers and Chat owns a new socket after route return", async ({
    page,
  }) => {
    const uiProtocol = createUiProtocolHarnessControl();
    await login(page, { uiProtocol });
    await expect
      .poll(() => methodCount(uiProtocol, "session/open"))
      .toBeGreaterThan(0);

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings(?:\?.*)?$/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // The Settings page owns a sessionless auxiliary bridge. Force its first
    // attempt to close before open, then prove the tab's Retry replaces that
    // terminal bridge. The login bootstrap can already have opened an
    // auxiliary socket, so close existing harness sockets before arming the
    // next startup failure.
    await uiProtocol.closeExistingSockets();
    uiProtocol.failStartup = true;
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(
      page.getByText(
        "Octos Core closed the UI Protocol connection before it became ready. Retry after checking the server.",
        { exact: true },
      ),
    ).toBeVisible();
    const attemptsBeforeRetry = uiProtocol.socketAttempts;

    uiProtocol.failStartup = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .poll(() => uiProtocol.socketAttempts)
      .toBeGreaterThan(attemptsBeforeRetry);
    await expect(
      page.getByText("Nothing here yet. Memory builds up as you chat", {
        exact: false,
      }),
    ).toBeVisible();

    // Chat -> Settings -> Chat must create a fresh session-scoped bridge;
    // Settings' auxiliary bridge cannot be adopted and then stopped by the
    // returning Chat provider.
    const attemptsBeforeReturn = uiProtocol.socketAttempts;
    await page.getByRole("button", { name: "Go back" }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator(SEL.chatInput)).toBeVisible();
    await expect
      .poll(() => uiProtocol.socketAttempts)
      .toBeGreaterThan(attemptsBeforeReturn);

    const text = "chat still owns a live bridge after returning from settings";
    await page.locator(SEL.chatInput).fill(text);
    await page.locator(SEL.sendButton).click();
    await expect
      .poll(() => methodCount(uiProtocol, "turn/start"))
      .toBe(1);
    await expect(
      page.locator("[data-testid='assistant-message']", {
        hasText: `Mock response: ${text}`,
      }),
    ).toHaveCount(1);
  });
});
