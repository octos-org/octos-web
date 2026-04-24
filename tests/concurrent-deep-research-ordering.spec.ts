/**
 * Extends `concurrent-deep-research.spec.ts` with strict ordering assertions.
 *
 * When the user fires Q1 then Q2 in rapid succession, the chat transcript must
 * render in interleaved order: user-Q1 → assistant-A1 → user-Q2 → assistant-A2.
 *
 * The pre-fix bug failed three distinct ways under ordering:
 *   1. A2 never appeared (queue-orphan)
 *   2. A2 appeared BEFORE A1 (out-of-order because the second stream landed first)
 *   3. A1's text was overwritten by A2 (correlation lost)
 *
 * This spec asserts document-order position, not just count/content.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-ordering-deep-research";

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

/**
 * Adversarial timing: the SECOND /api/chat POST completes FASTER than the
 * first. Under the pre-fix architecture, whichever SSE stream ended first
 * would be rendered first — producing out-of-order A2-before-A1. The fix
 * uses `response_to_client_message_id` to pair each response with its user
 * bubble, so ordering follows user-send-order regardless of response arrival.
 */
async function installOutOfOrderRuntime(page: Page) {
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

    // OUT-OF-ORDER: Q2 completes FAST (100ms), Q1 completes SLOW (3000ms).
    // This reproduces the race where the second stream lands first.
    const delayMs = myChatNum === 1 ? 3000 : 100;
    await new Promise((resolve) => setTimeout(resolve, delayMs));

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

test.describe("Concurrent deep-research ordering (coding-blue)", () => {
  test.beforeEach(async ({ page }) => {
    await installOutOfOrderRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);
  });

  test("two rapid user prompts render in send-order even if Q2 responds first", async ({
    page,
  }) => {
    const input = page.locator(SEL.chatInput);
    const send = page.locator(SEL.sendButton);

    // Q1
    await input.fill("Deep research one: ALPHA ordering marker");
    await send.click();

    // Q2 fires while Q1 is still streaming. Adversarial: Q2 will respond ~3s
    // before Q1 does (Q2 latency = 100ms, Q1 latency = 3000ms).
    await page.waitForTimeout(300);
    await input.fill("Deep research two: BRAVO ordering marker");
    await send.click();

    // Both user bubbles up immediately.
    await expect(page.locator(SEL.userMessage)).toHaveCount(2, {
      timeout: 10_000,
    });

    // Both assistant responses must land.
    await expect(page.locator(SEL.assistantMessage)).toHaveCount(2, {
      timeout: 15_000,
    });

    // Wait for BOTH bubbles to carry their payload. Two placeholder bubbles
    // exist as soon as the two user POSTs go out, so toHaveCount(2) above
    // resolves before A1's slow (~3s) response lands. The ordering-under-
    // out-of-order invariant is about which bubble ends up with which answer
    // once both have streamed in, not about the transient placeholder state.
    await page.waitForFunction(() => {
      const bubbles = Array.from(
        document.querySelectorAll('[data-testid="assistant-message"]'),
      );
      if (bubbles.length < 2) return false;
      return bubbles.every((node) => {
        const text = (node as HTMLElement).innerText || "";
        return /Research answer #\d/.test(text);
      });
    }, undefined, { timeout: 15_000 });

    // --- Ordering invariants ---

    // 1. User bubble order: Q1 ALPHA before Q2 BRAVO in the DOM.
    const userTexts = await page.locator(SEL.userMessage).allInnerTexts();
    expect(userTexts).toHaveLength(2);
    expect(userTexts[0]).toContain("ALPHA");
    expect(userTexts[1]).toContain("BRAVO");

    // 2. Assistant bubble order: A1 (#1 answering ALPHA) before A2 (#2 answering BRAVO).
    const assistantTexts = await page.locator(SEL.assistantMessage).allInnerTexts();
    expect(assistantTexts).toHaveLength(2);
    expect(assistantTexts[0]).toContain("#1");
    expect(assistantTexts[0]).toContain("ALPHA");
    expect(assistantTexts[1]).toContain("#2");
    expect(assistantTexts[1]).toContain("BRAVO");

    // 3. Interleaved transcript order: U1 → A1 → U2 → A2 in document order.
    const roles = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          '[data-testid="user-message"], [data-testid="assistant-message"]',
        ),
      );
      return nodes.map((n) =>
        (n as HTMLElement).dataset.testid === "user-message" ? "U" : "A",
      );
    });
    expect(roles).toEqual(["U", "A", "U", "A"]);

    // 4. No answer collapsed / cross-attached.
    expect(assistantTexts[0]).not.toContain("BRAVO");
    expect(assistantTexts[1]).not.toContain("ALPHA");
  });
});
