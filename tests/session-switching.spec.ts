import { test, expect, type Page, type Route } from "@playwright/test";
import {
  sendAndWait,
  createNewSession,
  countAssistantBubbles,
  countUserBubbles,
  getSessionItems,
  SEL,
  getChatThreadText,
} from "./helpers";

type MockMessage = {
  seq?: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  client_message_id?: string;
  response_to_client_message_id?: string;
};

type MockSession = {
  id: string;
  message_count: number;
};

const INITIAL_SESSION_ID = "web-1777000000000-switch-a";

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function installMockRuntime(page: Page) {
  const sessions: MockSession[] = [];
  const messagesBySession: Record<string, MockMessage[]> = {};
  let seq = 1;

  function now() {
    return new Date(1_777_000_000_000 + seq * 1000).toISOString();
  }

  function upsertSession(sessionId: string) {
    const messageCount = messagesBySession[sessionId]?.length ?? 0;
    const existing = sessions.find((session) => session.id === sessionId);
    if (existing) {
      existing.message_count = messageCount;
      return;
    }
    sessions.unshift({ id: sessionId, message_count: messageCount });
  }

  await page.route(/\/api\/auth\/status$/, (route) =>
    fulfillJson(route, {
      bootstrap_mode: false,
      email_login_enabled: true,
      admin_token_login_enabled: true,
      allow_self_registration: false,
    }),
  );

  await page.route(/\/api\/auth\/me$/, (route) =>
    fulfillJson(route, {
      user: {
        id: "user-1",
        email: "test@example.com",
        name: "Test User",
        role: "admin",
        created_at: "2026-04-20T12:00:00Z",
        last_login_at: null,
      },
      profile: { profile: { id: "dspfac" } },
      portal: {
        kind: "admin",
        home_profile_id: "dspfac",
        home_route: "/chat",
        can_access_admin_portal: false,
        can_manage_users: false,
        sub_account_limit: 0,
        accessible_profiles: [],
      },
    }),
  );

  await page.route(/\/api\/status$/, (route) =>
    fulfillJson(route, {
      version: "test",
      model: "mock-model",
      provider: "mock",
      uptime_secs: 1,
      agent_configured: true,
    }),
  );

  await page.route(/\/api\/sessions$/, (route) =>
    fulfillJson(route, sessions),
  );

  await page.route(/\/api\/sessions\/([^/]+)\/messages(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const sessionId = decodeURIComponent(url.pathname.split("/")[3] || "");
    return fulfillJson(route, messagesBySession[sessionId] ?? []);
  });

  await page.route(/\/api\/sessions\/[^/]+\/files$/, (route) =>
    fulfillJson(route, []),
  );

  await page.route(/\/api\/sessions\/[^/]+\/status(?:\?.*)?$/, (route) =>
    fulfillJson(route, {
      active: false,
      has_deferred_files: false,
      has_bg_tasks: false,
    }),
  );

  await page.route(/\/api\/sessions\/[^/]+\/tasks(?:\?.*)?$/, (route) =>
    fulfillJson(route, []),
  );

  await page.route(/\/api\/sessions\/[^/]+\/events\/stream(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([{ type: "replay_complete" }]),
    }),
  );

  await page.route(/\/api\/chat$/, async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}") as {
      message?: string;
      session_id?: string;
      client_message_id?: string;
    };
    const sessionId = payload.session_id || INITIAL_SESSION_ID;
    const prompt = payload.message || "";
    const clientMessageId = payload.client_message_id || `client-${seq}`;
    const response = `Mock response for: ${prompt}`;

    const messages = messagesBySession[sessionId] ?? [];
    messages.push({
      seq: seq++,
      role: "user",
      content: prompt,
      timestamp: now(),
      client_message_id: clientMessageId,
    });
    messages.push({
      seq: seq++,
      role: "assistant",
      content: response,
      timestamp: now(),
      response_to_client_message_id: clientMessageId,
    });
    messagesBySession[sessionId] = messages;
    upsertSession(sessionId);

    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "replace", text: response },
        {
          type: "done",
          content: response,
          model: "mock-model",
          tokens_in: 1,
          tokens_out: 1,
          duration_s: 1,
          has_bg_tasks: false,
        },
      ]),
    });
  });

  await page.addInitScript((sessionId) => {
    localStorage.clear();
    localStorage.setItem("octos_session_token", "mock-token");
    localStorage.setItem("octos_auth_token", "mock-token");
    localStorage.setItem("selected_profile", "dspfac");
    localStorage.setItem("octos_current_session", sessionId);
  }, INITIAL_SESSION_ID);
}

test.describe("Session switching", () => {
  test.beforeEach(async ({ page }) => {
    await installMockRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);
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
    const threadText = await getChatThreadText(page);
    expect(threadText).not.toContain("ALPHA-111");
    expect(threadText).toContain("BRAVO-222");
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
    const threadText = await getChatThreadText(page);
    expect(threadText).toContain("GAMMA-333");
    expect(threadText).not.toContain("DELTA-444");
  });

  test("session switching and replay do not create duplicate or ghost bubbles", async ({
    page,
  }) => {
    await sendAndWait(page, "Replay isolation marker: ALPHA-REPLAY", {
      label: "replay-s1",
      maxWait: 60_000,
    });
    await page.waitForTimeout(2000);

    const s1Id = await page
      .locator("[data-active='true']")
      .first()
      .getAttribute("data-session-id");
    expect(s1Id).toBeTruthy();

    await createNewSession(page);
    await sendAndWait(page, "Replay isolation marker: BRAVO-REPLAY", {
      label: "replay-s2",
      maxWait: 60_000,
    });
    await page.waitForTimeout(2000);

    const s2Id = await page.evaluate(() =>
      localStorage.getItem("octos_current_session"),
    );
    expect(s2Id).toBeTruthy();
    expect(s2Id).not.toBe(s1Id);
    const sessionOneId = s1Id!;
    const sessionTwoId = s2Id!;

    const assertOnlySessionOne = async () => {
      expect(await countUserBubbles(page)).toBe(1);
      expect(await countAssistantBubbles(page)).toBe(1);
      const threadText = await getChatThreadText(page);
      expect(threadText).toContain("ALPHA-REPLAY");
      expect(threadText).not.toContain("BRAVO-REPLAY");
      expect((threadText.match(/ALPHA-REPLAY/g) || []).length).toBe(2);
    };

    const assertOnlySessionTwo = async () => {
      expect(await countUserBubbles(page)).toBe(1);
      expect(await countAssistantBubbles(page)).toBe(1);
      const threadText = await getChatThreadText(page);
      expect(threadText).toContain("BRAVO-REPLAY");
      expect(threadText).not.toContain("ALPHA-REPLAY");
      expect((threadText.match(/BRAVO-REPLAY/g) || []).length).toBe(2);
    };

    await page
      .locator(`[data-session-id="${sessionOneId}"] [data-testid="session-switch-button"]`)
      .click();
    await expect(page.locator(`[data-session-id="${sessionOneId}"]`)).toHaveAttribute(
      "data-active",
      "true",
    );
    await assertOnlySessionOne();

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);
    await assertOnlySessionOne();

    await page
      .locator(`[data-session-id="${sessionTwoId}"] [data-testid="session-switch-button"]`)
      .click();
    await expect(page.locator(`[data-session-id="${sessionTwoId}"]`)).toHaveAttribute(
      "data-active",
      "true",
    );
    await assertOnlySessionTwo();

    await page
      .locator(`[data-session-id="${sessionOneId}"] [data-testid="session-switch-button"]`)
      .click();
    await expect(page.locator(`[data-session-id="${sessionOneId}"]`)).toHaveAttribute(
      "data-active",
      "true",
    );
    await assertOnlySessionOne();
  });
});
