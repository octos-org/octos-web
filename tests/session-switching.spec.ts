import { test, expect } from "@playwright/test";
import {
  login,
  sendAndWait,
  createNewSession,
  countAssistantBubbles,
  countUserBubbles,
  getSessionItems,
  switchToSession,
  SEL,
} from "./helpers";

test.describe("Session switching", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("new session starts with empty chat", async ({ page }) => {
    // Send a message in first session
    await sendAndWait(page, "Hello from session one", {
      label: "s1",
      maxWait: 60_000,
    });
    expect(await countAssistantBubbles(page)).toBe(1);

    // Create new session
    await createNewSession(page);

    // New session should be empty
    expect(await countAssistantBubbles(page)).toBe(0);
    expect(await countUserBubbles(page)).toBe(0);
  });

  test("sessions have isolated message history", async ({ page }) => {
    // Session 1: unique marker
    const r1 = await sendAndWait(page, "Session one marker: ALPHA-111", {
      label: "s1",
      maxWait: 60_000,
    });
    expect(r1.responseLen).toBeGreaterThan(0);

    // Create session 2
    await createNewSession(page);

    // Session 2: different marker
    const r2 = await sendAndWait(page, "Session two marker: BRAVO-222", {
      label: "s2",
      maxWait: 60_000,
    });
    expect(r2.responseLen).toBeGreaterThan(0);

    // Session 2 should have only its own messages
    expect(await countUserBubbles(page)).toBe(1);
    expect(await countAssistantBubbles(page)).toBe(1);

    // Body should NOT contain session 1 marker
    const body = await page.textContent("body");
    expect(body).not.toContain("ALPHA-111");
    expect(body).toContain("BRAVO-222");
  });

  test("sidebar shows sessions after sending messages", async ({ page }) => {
    // Send a message to create a session on the server
    await sendAndWait(page, "Hello sidebar test", {
      label: "sidebar",
      maxWait: 60_000,
    });

    // Wait for refreshSessions to complete (triggered by onMessageComplete)
    await page.waitForTimeout(2000);

    // Sidebar should now show at least 1 session item
    const items = await getSessionItems(page);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test("switching back to previous session restores history", async ({ page }) => {
    // Session 1: send a message
    const r1 = await sendAndWait(page, "Session one marker: GAMMA-333", {
      label: "s1",
      maxWait: 60_000,
    });
    expect(r1.responseLen).toBeGreaterThan(0);

    // Wait for session list to refresh and capture session 1's active element
    await page.waitForTimeout(2000);
    const s1Element = page.locator("[data-active='true']").first();
    const s1Id = await s1Element.getAttribute("data-session-id");
    expect(s1Id).toBeTruthy();

    // Create session 2 and send a message
    await createNewSession(page);
    const r2 = await sendAndWait(page, "Session two marker: DELTA-444", {
      label: "s2",
      maxWait: 60_000,
    });
    expect(r2.responseLen).toBeGreaterThan(0);
    await page.waitForTimeout(2000);

    // Switch back to session 1 by clicking its specific element
    const s1Item = page.locator(`[data-session-id="${s1Id}"] [data-testid="session-switch-button"]`);
    await s1Item.click();
    await page.waitForTimeout(3000);

    // Should see session 1 content in the thread
    const body = await page.textContent("body");
    expect(body).toContain("GAMMA-333");
    expect(body).not.toContain("DELTA-444");
  });
});
