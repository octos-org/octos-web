/**
 * FA-12 regression guard — speculative queue overflow delivery.
 *
 * Under `/queue speculative`, when a second user prompt arrives while the
 * first prompt's SSE stream is still live, the gateway returns a JSON ack:
 *   `{"status":"queued","message":"…"}`
 * and delivers the eventual reply as a `session_result` event on the
 * session-event-stream.
 *
 * Before FA-12:
 *   - stream-manager silently dropped the JSON ack body → bubble B stayed
 *     in "streaming" state forever.
 *   - webhook_proxy force-stamped `content-type: text/event-stream` on the
 *     outer response, so the JSON body looked like malformed SSE anyway.
 *   - session_actor's `serve_overflow` emitted the overflow reply with
 *     empty metadata → ApiChannel::send routed it only via pending (which
 *     was removed 2s earlier) and silently dropped the message.
 *
 * This spec mocks the full triangle and asserts that bubble B receives
 * content via the `session_result` event on the events/stream.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-speculative-delivery";

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
  // Captured clientMessageId of prompt B so the events/stream handler can
  // emit a matching response_to_client_message_id.
  let pendingBravoClientMessageId: string | null = null;

  function now() {
    return new Date(1_777_000_000_000 + seq * 1000).toISOString();
  }

  // Auth / status stubs
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

  // The events/stream stub models the FA-12 session-event delivery path:
  // after a short delay, emit `session_result` for prompt B carrying the
  // correlation id so the client's `findOptimisticMatchIndex` can merge it
  // into bubble B.
  await page.route(/\/api\/sessions\/[^/]+\/events\/stream(?:\?.*)?$/, async (route) => {
    // Wait until the overflow reply would have been generated server-side.
    // The polling loop in sse-bridge.ts wakes on crew:queued_ack and starts
    // this stream; we delay briefly then emit the session_result.
    let resolved = false;
    const start = Date.now();
    while (!pendingBravoClientMessageId && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const clientMessageId = pendingBravoClientMessageId ?? "unknown";
    resolved = true;
    // A brief extra delay so the bubble has a chance to render in streaming state.
    await new Promise((r) => setTimeout(r, 200));

    const events: unknown[] = [{ type: "replay_complete" }];
    if (resolved) {
      events.push({
        type: "session_result",
        topic: null,
        message: {
          seq: 42,
          role: "assistant",
          content: "Speculative overflow response for BRAVO",
          timestamp: now(),
          response_to_client_message_id: clientMessageId,
          media: [],
          tool_calls: [],
        },
      });
    }

    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse(events),
    });
  });

  // /api/chat path. First POST (ALPHA) returns a normal SSE stream with
  // `done`. Second POST (BRAVO) returns a JSON queued-ack — no SSE stream.
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

    if (myChatNum === 1) {
      // ALPHA: normal SSE stream
      const response = `Answer for ALPHA: ${prompt}`;
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
      await new Promise((resolve) => setTimeout(resolve, 100));
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
      return;
    }

    // BRAVO: queued JSON ack. Record the correlation id so the
    // events/stream mock can emit a matching session_result.
    pendingBravoClientMessageId = clientMessageId;
    messages.push({
      seq: seq++,
      role: "user",
      content: prompt,
      timestamp: now(),
      client_message_id: clientMessageId,
    });
    // Do NOT push the assistant message here — it arrives via session_result
    // on the events/stream, mirroring the overflow path.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "queued",
        message: "Message queued — response will arrive on the existing stream",
      }),
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

test.describe("FA-12 speculative delivery regression", () => {
  test.beforeEach(async ({ page }) => {
    await installMockRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);
  });

  test("JSON queued ack delivers overflow reply into bubble B", async ({ page }) => {
    const input = page.locator(SEL.chatInput);
    const send = page.locator(SEL.sendButton);

    // Prompt ALPHA — normal SSE response.
    await input.fill("FA-12 ALPHA prompt");
    await send.click();

    // Wait for ALPHA's bubble to finalize so its SSE stream is live when
    // BRAVO fires. We only need the stream to have started, not finished,
    // but the mock is fast enough to complete regardless.
    await page.waitForTimeout(400);

    // Prompt BRAVO — server returns JSON ack; overflow reply comes via
    // events/stream.
    await input.fill("FA-12 BRAVO prompt — speculative overflow");
    await send.click();

    // Both user bubbles present.
    await expect(page.locator(SEL.userMessage)).toHaveCount(2, {
      timeout: 10_000,
    });
    // Both assistant bubbles present.
    await expect(page.locator(SEL.assistantMessage)).toHaveCount(2, {
      timeout: 15_000,
    });

    // The critical assertion: BRAVO's bubble (the second assistant bubble)
    // must receive the overflow text via the session_result event path.
    // Before the FA-12 fix, it stayed empty / stuck in "streaming".
    await page.waitForFunction(() => {
      const bubbles = document.querySelectorAll('[data-testid="assistant-message"]');
      if (bubbles.length < 2) return false;
      const text = (bubbles[1] as HTMLElement).innerText || "";
      return text.includes("Speculative overflow response for BRAVO");
    }, undefined, { timeout: 15_000 });

    const bubbles = page.locator(SEL.assistantMessage);
    const textA = (await bubbles.nth(0).innerText()).trim();
    const textB = (await bubbles.nth(1).innerText()).trim();
    expect(textA).toContain("ALPHA");
    expect(textB).toContain("Speculative overflow response for BRAVO");
  });
});

// -----------------------------------------------------------------------------
// FA-12f regression: server broadcasts overflow session_result onto the PRIMARY
// turn's SSE stream (ApiChannel sends to `pending[chat_id]` in addition to the
// watchers fanout). Before this fix, sse-bridge's session_result handler
// blindly merged every event into the primary bubble's assistantMsgId,
// overwriting ALPHA's bubble with BRAVO's reply and then collapsing BRAVO's
// streaming bubble as a "duplicate". End result: BRAVO never rendered.
//
// The fix routes session_result by response_to_client_message_id correlation:
// if the event is for a different bubble, go through appendHistoryMessages so
// findOptimisticMatchIndex picks BRAVO's streaming bubble.
// -----------------------------------------------------------------------------

const FA12F_SESSION_ID = "web-fa12f-primary-sse";

async function installFa12fMockRuntime(page: Page) {
  const messages: MockMessage[] = [];
  let seq = 1;
  let alphaClientMessageId: string | null = null;
  let bravoClientMessageId: string | null = null;
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
    fulfillJson(route, [{ id: FA12F_SESSION_ID, message_count: messages.length }]),
  );
  await page.route(/\/api\/sessions\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    fulfillJson(route, messages),
  );
  await page.route(/\/api\/sessions\/[^/]+\/files$/, (route) =>
    fulfillJson(route, []),
  );
  await page.route(/\/api\/sessions\/[^/]+\/status(?:\?.*)?$/, (route) =>
    fulfillJson(route, { active: false, has_deferred_files: false, has_bg_tasks: false }),
  );
  await page.route(/\/api\/sessions\/[^/]+\/tasks(?:\?.*)?$/, (route) =>
    fulfillJson(route, []),
  );
  await page.route(
    /\/api\/sessions\/[^/]+\/events\/stream(?:\?.*)?$/,
    async (route) =>
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

    if (myChatNum === 1) {
      // ALPHA: long-lived SSE stream. BRAVO's session_result is spliced in
      // mid-stream, mirroring the real ApiChannel broadcast path.
      alphaClientMessageId = clientMessageId;
      const alphaResponse = "ALPHA-speculative-1";
      const bravoResponse = "BRAVO-speculative-2";

      messages.push({
        seq: seq++,
        role: "user",
        content: prompt,
        timestamp: now(),
        client_message_id: clientMessageId,
      });

      // Build the SSE stream. Wait a beat so BRAVO's POST has landed and
      // we've captured its client_message_id.
      await new Promise((r) => setTimeout(r, 500));

      // Splice BRAVO's session_result in the middle of ALPHA's stream,
      // with BRAVO's client_message_id as the correlation.
      const bravoCmidForEvent = bravoClientMessageId ?? "client-bravo-unknown";
      const events: unknown[] = [
        { type: "replace", text: "ALPHA starting..." },
        // BRAVO's overflow tokens leak onto ALPHA's SSE (shared pending[chat_id]).
        { type: "replace", text: "BR" },
        { type: "token", text: "AVO-speculative-2" },
        {
          type: "session_result",
          topic: null,
          message: {
            seq: 42,
            role: "assistant",
            content: bravoResponse,
            timestamp: now(),
            response_to_client_message_id: bravoCmidForEvent,
            media: [],
            tool_calls: [],
          },
        },
        // ALPHA recovers and finishes.
        { type: "replace", text: `\u2b06\ufe0f Earlier task completed:\n\n${alphaResponse}` },
        {
          type: "done",
          content: `\u2b06\ufe0f Earlier task completed:\n\n${alphaResponse}`,
          model: "mock-model",
          tokens_in: 1,
          tokens_out: 1,
          duration_s: 1,
          has_bg_tasks: false,
        },
      ];

      // Persist authoritative messages on disk so a late-subscribing
      // watcher / polling fallback could recover too. (Mirrors the real
      // server persisting both replies to the session store.)
      messages.push({
        seq: seq++,
        role: "assistant",
        content: bravoResponse,
        timestamp: now(),
        response_to_client_message_id: bravoCmidForEvent,
      });
      messages.push({
        seq: seq++,
        role: "assistant",
        content: `\u2b06\ufe0f Earlier task completed:\n\n${alphaResponse}`,
        timestamp: now(),
        response_to_client_message_id: clientMessageId,
      });

      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse(events),
      });
      return;
    }

    // BRAVO: JSON queued ack.
    bravoClientMessageId = clientMessageId;
    messages.push({
      seq: seq++,
      role: "user",
      content: prompt,
      timestamp: now(),
      client_message_id: clientMessageId,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "queued",
        message: "Message queued — response will arrive on the existing stream",
      }),
    });
  });

  await page.addInitScript((sessionId) => {
    localStorage.clear();
    localStorage.setItem("octos_session_token", "mock-token");
    localStorage.setItem("octos_auth_token", "mock-token");
    localStorage.setItem("selected_profile", "dspfac");
    localStorage.setItem("octos_current_session", sessionId);
  }, FA12F_SESSION_ID);

  // Return the ref so the test can assert on captured ids if it wants.
  return { getAlphaCmid: () => alphaClientMessageId };
}

test.describe("FA-12f: session_result on primary SSE routes by correlation", () => {
  test.beforeEach(async ({ page }) => {
    await installFa12fMockRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);
  });

  test("BRAVO session_result spliced into ALPHA's SSE must render BRAVO's bubble, not clobber ALPHA", async ({
    page,
  }) => {
    const input = page.locator(SEL.chatInput);
    const send = page.locator(SEL.sendButton);

    await input.fill("FA-12f ALPHA prompt");
    await send.click();

    // Send BRAVO quickly so its client_message_id is captured before
    // ALPHA's SSE stream emits the session_result event.
    await page.waitForTimeout(100);
    await input.fill("FA-12f BRAVO prompt");
    await send.click();

    await expect(page.locator(SEL.userMessage)).toHaveCount(2, {
      timeout: 10_000,
    });
    await expect(page.locator(SEL.assistantMessage)).toHaveCount(2, {
      timeout: 15_000,
    });

    // Wait for the bubbles to settle. The critical invariants:
    //   (1) ALPHA's bubble carries the ALPHA text (NOT BRAVO's — if the
    //       reducer blindly merged the session_result into ALPHA's
    //       assistantMsgId, ALPHA would show BRAVO's content briefly and
    //       then the collapse pass would destroy BRAVO's bubble).
    //   (2) BRAVO's bubble carries the BRAVO text, not empty and not ALPHA's.
    await page.waitForFunction(() => {
      const bubbles = Array.from(
        document.querySelectorAll('[data-testid="assistant-message"]'),
      );
      if (bubbles.length !== 2) return false;
      const texts = bubbles.map((el) => (el as HTMLElement).innerText || "");
      const hasBoth =
        texts.some((t) => t.includes("ALPHA-speculative-1")) &&
        texts.some((t) => t.includes("BRAVO-speculative-2"));
      return hasBoth;
    }, undefined, { timeout: 15_000 });

    const bubbles = page.locator(SEL.assistantMessage);
    const textA = (await bubbles.nth(0).innerText()).trim();
    const textB = (await bubbles.nth(1).innerText()).trim();

    // ALPHA's bubble must carry ALPHA's final text, NOT BRAVO's.
    expect(textA).toContain("ALPHA-speculative-1");
    expect(textA).not.toContain("BRAVO-speculative-2");

    // BRAVO's bubble must carry BRAVO's reply.
    expect(textB).toContain("BRAVO-speculative-2");
    expect(textB).not.toContain("ALPHA-speculative-1");
  });
});
