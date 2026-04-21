import { test, expect } from "@playwright/test";
import { login } from "./helpers";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";
const PROFILE_ID = process.env.PROFILE_ID || "dspfac";

function apiHeaders() {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "X-Profile-Id": PROFILE_ID,
    "Content-Type": "application/json",
  };
}

test.describe("Session deletion", () => {
  test("sidebar deletion removes the session across tabs and from the API", async ({
    page,
    request,
  }) => {
    const sessionId = `web-${Date.now()}-delete-ui`;
    const encodedSessionId = encodeURIComponent(sessionId);

    const createResp = await request.post("/api/chat", {
      headers: apiHeaders(),
      data: {
        session_id: sessionId,
        message: "Reply exactly OK for session deletion regression.",
      },
      timeout: 120_000,
    });
    expect(createResp.ok()).toBeTruthy();

    await login(page);
    const secondPage = await page.context().newPage();
    await login(secondPage);

    const firstItem = page.locator(`[data-session-id="${sessionId}"]`);
    const secondItem = secondPage.locator(`[data-session-id="${sessionId}"]`);
    await expect(firstItem).toBeVisible();
    await expect(secondItem).toBeVisible();

    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes(`/api/sessions/${encodedSessionId}`),
    );

    await firstItem.hover();
    await firstItem.locator("[data-testid='session-delete-button']").click();
    await firstItem.getByTitle("Confirm delete").click();

    const resp = await deleteResponse;
    expect(resp.ok()).toBeTruthy();

    await expect(page.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0);
    await expect(secondPage.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0);

    const listResp = await request.get("/api/sessions", {
      headers: apiHeaders(),
    });
    expect(listResp.ok()).toBeTruthy();
    const sessions = (await listResp.json()) as { id?: string }[];
    expect(sessions.some((session) => session.id === sessionId)).toBe(false);
  });
});
