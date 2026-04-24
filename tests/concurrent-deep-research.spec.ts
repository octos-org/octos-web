/**
 * Regression guard for the queue-removal fix (main commits 9f5a250 + 6a476ef).
 *
 * Two rapid-fire user prompts must both receive their own assistant response
 * bubbles. On the pre-fix code path, the second prompt was silently dropped
 * because the client-side queue swallowed it until the first SSE stream ended.
 * The assertion: send two prompts ~500ms apart and verify both responses
 * render with non-empty text.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-concurrent-deep-research";

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

interface MockMessage {
  seq: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  client_message_id?: string;
  response_to_client_message_id?: string;
}

async function installMockRuntime(page: Page) {
  const messages: MockMessage[] = [];
  let seq = 1;
  let chatCount = 0;

  function now() {
    return new Date(1_777_000_000_000 + seq * 1000).toISOString();
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
    fulfillJson(route, [{ id: SESSION_ID, message_count: messages.length }]),
  );

  await page.route(/\/api\/sessions\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    fulfillJson(route, messages),
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
      body: sse([{ type: "replay_complete" }]),
    }),
  );

  // The critical behavior under test: two /api/chat POSTs must both reach the
  // server. The backend would queue them internally, but the client-side
  // message queue must NOT exist. Each POST produces its own SSE stream with
  // its own response.
  await page.route(/\/api\/chat$/, async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}") as {
      message?: string;
      session_id?: string;
      client_message_id?: string;
    };
    chatCount += 1;
    const myChatNum = chatCount;
    const prompt = payload.message || "";
    const clientMessageId = payload.client_message_id || `client-${myChatNum}`;
    const response = `Research answer #${myChatNum} for: ${prompt}`;

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

    // Small artificial server-side latency so the two prompts overlap on the
    // client. The second POST will be in flight before the first SSE `done`
    // lands. If a client queue existed, the second POST would be deferred and
    // we'd see only one user bubble or a dropped response.
    await new Promise((resolve) => setTimeout(resolve, 250 * myChatNum));

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
  }, SESSION_ID);
}

test.describe("Concurrent deep-research queue-removal guard", () => {
  test.beforeEach(async ({ page }) => {
    await installMockRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);
  });

  test("two rapid user prompts both produce non-empty assistant responses", async ({
    page,
  }) => {
    const input = page.locator(SEL.chatInput);
    const send = page.locator(SEL.sendButton);

    // First prompt
    await input.fill("Deep research one: ALPHA concurrency marker");
    await send.click();

    // Second prompt ~500ms later, without waiting for the first to finish.
    await page.waitForTimeout(500);
    await input.fill("Deep research two: BRAVO concurrency marker");
    await send.click();

    // Both user bubbles must be present immediately (POST was issued for both).
    await expect(page.locator(SEL.userMessage)).toHaveCount(2, {
      timeout: 10_000,
    });

    // Both assistant responses must land.
    await expect(page.locator(SEL.assistantMessage)).toHaveCount(2, {
      timeout: 30_000,
    });

    // Give the second response a moment to settle after the first.
    await page.waitForFunction(() => {
      const bubbles = document.querySelectorAll('[data-testid="assistant-message"]');
      if (bubbles.length < 2) return false;
      const text = (bubbles[1] as HTMLElement).innerText || "";
      return text.includes("#2");
    }, undefined, { timeout: 15_000 });

    // And both must be non-empty.
    const bubbles = page.locator(SEL.assistantMessage);
    const texts: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const text = (await bubbles.nth(i).innerText()).trim();
      expect(text.length).toBeGreaterThan(0);
      texts.push(text);
    }

    // And the two answers should differ — not one shared answer overwriting the
    // other. The fix keeps per-request response correlation via
    // response_to_client_message_id.
    expect(texts[0]).not.toBe(texts[1]);
    expect(texts.join(" ")).toContain("#1");
    expect(texts.join(" ")).toContain("#2");
  });
});
