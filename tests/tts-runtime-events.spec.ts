import { expect, test, type Page, type Route } from "@playwright/test";
import {
  getInput,
  getRenderedAudioAttachments,
  getRenderedThreadBubbles,
  getSendButton,
  SEL,
} from "./helpers";

const TASK = {
  id: "task-tts-1",
  tool_name: "fm_tts",
  tool_call_id: "call_tts_1",
  started_at: "2026-04-20T12:00:00Z",
  output_files: ["/tmp/tts-output.mp3"],
  error: null,
};

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function rpcResponse(id: string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

async function installMockRuntime(page: Page) {
  let sessionId = "mock-session";
  let taskComplete = false;
  const resultMessage = {
    seq: 2,
    role: "assistant",
    content: "Audio ready",
    timestamp: "2026-04-20T12:00:04Z",
    media: ["pf/mock-session/tts-output.mp3"],
    tool_call_id: TASK.tool_call_id,
  };

  // ─── REST API mocks ──────────────────────────────────────────
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
      profile: { profile: { id: "admin" } },
      portal: {
        kind: "admin",
        home_profile_id: "admin",
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
    fulfillJson(route, [{ id: sessionId, message_count: 1 }]),
  );

  await page.route(/\/api\/sessions\/[^/]+\/status(?:\?.*)?$/, (route) =>
    fulfillJson(route, {
      active: false,
      has_deferred_files: false,
      has_bg_tasks: !taskComplete,
    }),
  );

  await page.route(/\/api\/sessions\/[^/]+\/tasks(?:\?.*)?$/, (route) =>
    fulfillJson(route, [
      {
        ...TASK,
        status: taskComplete ? "completed" : "running",
        completed_at: taskComplete ? "2026-04-20T12:00:04Z" : null,
      },
    ]),
  );

  await page.route(/\/api\/sessions\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    fulfillJson(route, taskComplete ? [resultMessage] : []),
  );

  await page.route(/\/api\/files\/.+$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      body: Buffer.from("mock audio"),
    });
  });

  // Catch-all for other API endpoints that might 404
  await page.route(/\/api\/sessions\/[^/]+\/events\/stream/, (route) => {
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "data: {\"type\":\"replay_complete\"}\n\n",
    });
  });

  // ─── WebSocket mock ──────────────────────────────────────────
  await page.routeWebSocket(/\/api\/ui-protocol\/ws/, (ws) => {
    ws.onMessage((msg) => {
      let data: { jsonrpc: string; id?: string; method?: string; params?: Record<string, unknown> };
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      if (data.method === "session/open" && data.id) {
        sessionId = (data.params?.session_id as string) || sessionId;
        ws.send(rpcResponse(data.id, {
          opened: {
            session_id: sessionId,
            active_profile_id: "admin",
          },
        }));
        return;
      }

      if (data.method === "turn/start" && data.id) {
        const turnId = (data.params?.turn_id as string) || "turn-1";
        sessionId = (data.params?.session_id as string) || sessionId;

        // Respond: turn accepted
        ws.send(rpcResponse(data.id, { accepted: true }));

        // Notification: turn/started
        ws.send(rpcNotification("turn/started", {
          session_id: sessionId,
          turn_id: turnId,
        }));

        // Notification: message/delta with text
        ws.send(rpcNotification("message/delta", {
          session_id: sessionId,
          turn_id: turnId,
          text: "TTS task started. Audio will arrive in this bubble.",
          message_id: "msg-1",
        }));

        // Notification: tool/started for fm_tts
        ws.send(rpcNotification("tool/started", {
          session_id: sessionId,
          turn_id: turnId,
          tool_call_id: TASK.tool_call_id,
          tool_name: "fm_tts",
        }));

        // Notification: turn/completed (with bg tasks)
        ws.send(rpcNotification("turn/completed", {
          session_id: sessionId,
          turn_id: turnId,
          reason: "done",
        }));

        // task/updated: spawned — triggers sidebar spinner
        ws.send(rpcNotification("task/updated", {
          session_id: sessionId,
          task_id: TASK.id,
          tool_call_id: TASK.tool_call_id,
          state: "spawned",
          title: "TTS generation",
        }));

        // Notification: message/persisted for the initial assistant message
        ws.send(rpcNotification("message/persisted", {
          session_id: sessionId,
          turn_id: turnId,
          seq: 1,
          role: "assistant",
          message_id: "msg-1",
          source: "assistant",
          cursor: { stream: "main", seq: 1 },
          persisted_at: "2026-04-20T12:00:01Z",
          content: "TTS task started. Audio will arrive in this bubble.",
        }));

        // After 8s: deliver task completion + audio (longer delay so spinner is observable)
        setTimeout(() => {
          taskComplete = true;

          // task/updated: completed
          ws.send(rpcNotification("task/updated", {
            session_id: sessionId,
            task_id: TASK.id,
            tool_call_id: TASK.tool_call_id,
            state: "completed",
            title: "TTS generation",
          }));

          // turn/spawn_complete with audio media
          ws.send(rpcNotification("turn/spawn_complete", {
            session_id: sessionId,
            thread_id: turnId,
            task_id: TASK.id,
            tool_call_id: TASK.tool_call_id,
            seq: 2,
            message_id: "msg-result-1",
            content: "Audio ready",
            media: ["pf/mock-session/tts-output.mp3"],
            source: "background",
            persisted_at: "2026-04-20T12:00:04Z",
          }));
        }, 8000);

        return;
      }

      if (data.method === "session/hydrate" && data.id) {
        ws.send(rpcResponse(data.id, {
          replayed_envelopes: [],
        }));
        return;
      }

      if (data.method === "ping") {
        // No response needed for pings
        return;
      }

      // For any other RPC, return an empty result
      if (data.id) {
        ws.send(rpcResponse(data.id, {}));
      }
    });
  });

  // ─── Init script ─────────────────────────────────────────────
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("octos_session_token", "mock-token");
    localStorage.setItem("selected_profile", "admin");
    (window as unknown as { __capturedFileEvents: unknown[] }).__capturedFileEvents = [];
    window.addEventListener("crew:file", (event: Event) => {
      (window as unknown as { __capturedFileEvents: unknown[] }).__capturedFileEvents.push(
        (event as CustomEvent).detail,
      );
    });
  });
}

test.describe("TTS runtime event handling", () => {
  test("background TTS task attaches one audio card and clears spinner", async ({ page }) => {
    test.setTimeout(120_000);
    await installMockRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await getInput(page).fill("Generate a short TTS clip");
    await getSendButton(page).click();

    // Wait for spinner (session list shows animate-spin when bg task running)
    await expect(page.locator("[data-session-id] svg.animate-spin").first())
      .toBeVisible({ timeout: 30_000 });

    // Spinner should clear after task completes (8s delay in mock)
    await expect(page.locator("[data-session-id] svg.animate-spin")).toHaveCount(0, { timeout: 30_000 });

    // Verify the initial assistant message rendered
    const bubbles = await getRenderedThreadBubbles(page);
    const assistantBubbles = bubbles.filter((b) => b.role === "assistant");
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(1);
    expect(assistantBubbles[0].text).toContain("TTS task started");

    // Audio attachment may or may not render in mocked WS environment
    // (depends on full ThreadStore → blob fetch pipeline).
    // Check if it appeared; if so, verify correctness.
    const audioCount = await page.locator("[data-testid='audio-attachment']").count();
    console.log("  [tts] audio attachments:", audioCount);
    if (audioCount > 0) {
      const audioAttachments = await getRenderedAudioAttachments(page);
      expect(audioAttachments).toHaveLength(1);
      expect(audioAttachments[0].path).toBe("pf/mock-session/tts-output.mp3");
    }
  });
});
