import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-delete-dup";
const TOPIC_SESSION_ID = `${SESSION_ID}#research`;
const OTHER_SESSION_ID = "web-other-chat";

type MockSession = { id: string; message_count: number };
type MockRuntimeOptions = {
  deleteStatus?: number;
};

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function sessionGroup(id: string): string {
  return id.split("#", 1)[0];
}

async function installMockRuntime(
  page: Page,
  sessions: MockSession[],
  options: MockRuntimeOptions = {},
) {
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

  await page.route(/\/api\/sessions$/, (route) => fulfillJson(route, sessions));

  await page.route(/\/api\/sessions\/([^/]+)$/, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    const id = decodeURIComponent(url.pathname.split("/")[3] || "");
    if (options.deleteStatus && options.deleteStatus >= 400) {
      await route.fulfill({
        status: options.deleteStatus,
        contentType: "application/json",
        body: JSON.stringify({ error: "delete failed" }),
      });
      return;
    }
    const group = sessionGroup(id);
    for (let index = sessions.length - 1; index >= 0; index--) {
      if (sessionGroup(sessions[index].id) === group) {
        sessions.splice(index, 1);
      }
    }
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route(/\/api\/sessions\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    fulfillJson(route, [
      {
        role: "user",
        content: "session title",
        timestamp: "2026-04-20T12:00:00Z",
      },
    ]),
  );

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
      body: `data: ${JSON.stringify({ type: "replay_complete" })}\n\n`,
    }),
  );

  await page.addInitScript((sessionId) => {
    localStorage.clear();
    localStorage.setItem("octos_session_token", "mock-token");
    localStorage.setItem("octos_auth_token", "mock-token");
    localStorage.setItem("selected_profile", "dspfac");
    localStorage.setItem("octos_current_session", sessionId);
  }, SESSION_ID);
}

async function fetchSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const resp = await fetch("/api/sessions", { cache: "no-store" });
    if (!resp.ok) throw new Error(`/api/sessions returned ${resp.status}`);
    const sessions = (await resp.json()) as Array<{ id?: unknown }>;
    return sessions
      .map((session) => (typeof session?.id === "string" ? session.id : null))
      .filter((id): id is string => Boolean(id));
  });
}

async function openMockedBrowser(browser: Browser, sessions: MockSession[]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installMockRuntime(page, sessions);
  await page.goto("/chat", { waitUntil: "networkidle" });
  await page.waitForSelector(SEL.chatInput);
  return { context, page };
}

test.describe("session deletion", () => {
  test("deleting a session removes topic siblings across browsers", async ({
    browser,
    page,
  }) => {
    const sessions = [
      { id: SESSION_ID, message_count: 1 },
      { id: TOPIC_SESSION_ID, message_count: 1 },
      { id: OTHER_SESSION_ID, message_count: 1 },
    ];
    await installMockRuntime(page, sessions);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.locator(`[data-session-id="${SESSION_ID}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-session-id="${TOPIC_SESSION_ID}"]`)).toHaveCount(0);

    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname ===
          `/api/sessions/${encodeURIComponent(SESSION_ID)}`,
    );

    await page
      .locator(`[data-session-id="${SESSION_ID}"] [data-testid='session-delete-button']`)
      .click({ force: true });
    await page.locator('button[title="Confirm delete"]').click();
    expect((await deleteResponse).status()).toBe(204);

    await expect
      .poll(
        async () => (await fetchSessionIds(page)).filter((id) => id.startsWith(SESSION_ID)),
        { timeout: 5_000 },
      )
      .toEqual([]);
    await expect(page.locator(`[data-session-id="${SESSION_ID}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-session-id="${TOPIC_SESSION_ID}"]`)).toHaveCount(0);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);
    await expect(page.locator(`[data-session-id="${SESSION_ID}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-session-id="${TOPIC_SESSION_ID}"]`)).toHaveCount(0);

    const other = await openMockedBrowser(browser, sessions);
    try {
      await expect(other.page.locator(`[data-session-id="${SESSION_ID}"]`)).toHaveCount(0);
      await expect(other.page.locator(`[data-session-id="${TOPIC_SESSION_ID}"]`)).toHaveCount(0);
    } finally {
      await other.context.close();
    }
  });

  test("failed delete does not persist a deleted-session tombstone", async ({
    page,
  }) => {
    const sessions = [
      { id: SESSION_ID, message_count: 1 },
      { id: OTHER_SESSION_ID, message_count: 1 },
    ];
    await installMockRuntime(page, sessions, { deleteStatus: 500 });
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.locator(`[data-session-id="${SESSION_ID}"]`)).toHaveCount(1);

    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname ===
          `/api/sessions/${encodeURIComponent(SESSION_ID)}`,
    );

    await page
      .locator(`[data-session-id="${SESSION_ID}"] [data-testid='session-delete-button']`)
      .click({ force: true });
    await page.locator('button[title="Confirm delete"]').click();
    expect((await deleteResponse).status()).toBe(500);

    await expect(page.locator(`[data-session-id="${SESSION_ID}"]`)).toHaveCount(1);
    const deletedIds = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("octos_deleted_sessions") || "[]"),
    );
    expect(deletedIds).not.toContain(SESSION_ID);
  });

  test("renders all sessions instead of revealing hidden rows after delete", async ({
    page,
  }) => {
    const sessions = Array.from({ length: 22 }, (_, index) => ({
      id: `web-overflow-${String(index).padStart(2, "0")}`,
      message_count: 1,
    }));
    const oldestVisibleId = sessions.at(-1)!.id;

    await installMockRuntime(page, sessions);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.locator('[data-session-id^="web-overflow-"]')).toHaveCount(22);

    await page
      .locator(`[data-session-id="${oldestVisibleId}"] [data-testid='session-delete-button']`)
      .click({ force: true });
    await page.locator('button[title="Confirm delete"]').click();

    await expect(page.locator(`[data-session-id="${oldestVisibleId}"]`)).toHaveCount(0);
    await expect(page.locator('[data-session-id^="web-overflow-"]')).toHaveCount(21);
  });
});
