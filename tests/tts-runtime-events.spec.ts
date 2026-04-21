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

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMockRuntime(page: Page) {
  let sessionId = "";
  let streamCount = 0;
  let taskComplete = false;
  const resultMessage = {
    seq: 2,
    role: "assistant",
    content: "Audio ready",
    timestamp: "2026-04-20T12:00:04Z",
    media: ["pf/mock-session/tts-output.mp3"],
    tool_call_id: TASK.tool_call_id,
  };

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
    fulfillJson(
      route,
      sessionId ? [{ id: sessionId, message_count: 1 }] : [],
    ),
  );

  await page.route(/\/api\/sessions\/[^/]+\/status(?:\?.*)?$/, (route) =>
    fulfillJson(route, {
      active: false,
      has_deferred_files: false,
      has_bg_tasks: false,
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

  await page.route(/\/api\/sessions\/[^/]+\/events\/stream(?:\?.*)?$/, async (route) => {
    streamCount += 1;

    if (streamCount === 1) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([
          {
            type: "task_status",
            task: { ...TASK, status: "running", completed_at: null },
          },
          { type: "replay_complete" },
        ]),
      });
      return;
    }

    await page.waitForTimeout(2500);
    taskComplete = true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "session_result", message: resultMessage },
        {
          type: "task_status",
          task: {
            ...TASK,
            status: "completed",
            completed_at: "2026-04-20T12:00:04Z",
          },
        },
        { type: "replay_complete" },
      ]),
    });
  });

  await page.route(/\/api\/files\/.+$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      body: Buffer.from("mock audio"),
    });
  });

  await page.route(/\/api\/chat$/, async (route) => {
    const body = route.request().postDataJSON() as { session_id?: string };
    sessionId = body.session_id || sessionId;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        {
          type: "replace",
          text: "TTS task started. Audio will arrive in this bubble.",
        },
        {
          type: "tool_start",
          tool: "fm_tts",
          tool_call_id: TASK.tool_call_id,
        },
        {
          type: "done",
          content: "TTS task started. Audio will arrive in this bubble.",
          model: "mock-model",
          tokens_in: 1,
          tokens_out: 1,
          duration_s: 1,
          has_bg_tasks: true,
        },
      ]),
    });
  });

  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("octos_session_token", "mock-token");
    localStorage.setItem("selected_profile", "dspfac");
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
    await installMockRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await getInput(page).fill("Generate a short TTS clip");
    await getSendButton(page).click();

    await expect(page.locator("[data-session-id] svg.animate-spin").first()).toBeVisible();

    await expect(page.locator("[data-testid='audio-attachment']")).toHaveCount(1);
    await expect(page.locator("[data-session-id] svg.animate-spin")).toHaveCount(0);

    const audioAttachments = await getRenderedAudioAttachments(page);
    expect(audioAttachments).toHaveLength(1);
    expect(audioAttachments[0].path).toBe("pf/mock-session/tts-output.mp3");

    const bubbles = await getRenderedThreadBubbles(page);
    const assistantWithAudio = bubbles.filter(
      (bubble) => bubble.role === "assistant" && bubble.audioAttachments.length > 0,
    );
    expect(assistantWithAudio).toHaveLength(1);
    expect(assistantWithAudio[0].text).toContain("TTS task started");
    expect(assistantWithAudio[0].audioAttachments).toHaveLength(1);

    const fileEvents = await page.evaluate(
      () => (window as unknown as { __capturedFileEvents: unknown[] }).__capturedFileEvents,
    );
    expect(fileEvents).toHaveLength(1);
  });
});
