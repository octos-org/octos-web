/**
 * Bug class #4 — Background task file attaches to wrong message bubble.
 *
 * Before Phase 3+4: file events that arrived after the assistant bubble
 * closed fell back through a chain of heuristics in
 * appendFileToBackgroundAnchor() — path match, tool name match, recent
 * assistant bubble lookup. When a second assistant bubble was created
 * between the task spawning and the file arriving, the heuristic could pick
 * the wrong bubble and attach the file there. Previous coverage
 * (PR #40 file-artifact-reducer) locked down the reducer-level identity
 * rules; this test extends that into the full runtime by driving a two-turn
 * scenario via the SSE bridge.
 *
 * With Phase 3+4, the file-artifact-reducer is the single authority for
 * attaching files, and background-task-reducer owns the task anchor it
 * belongs to. The file must land on the task-anchor bubble associated with
 * its tool_call_id, NOT on a later unrelated assistant turn.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-file-attachment-identity";
const TASK_ID = "task-file-identity-001";
const TOOL_CALL_ID = "call-file-identity-001";

const FILE_PATH = "/artifacts/deep-research-output.md";
const FILE_NAME = "deep-research-output.md";

const RUNNING_TASK = {
  id: TASK_ID,
  tool_name: "Deep research",
  tool_call_id: TOOL_CALL_ID,
  status: "running" as const,
  started_at: "2026-04-20T12:00:00Z",
  completed_at: null,
  output_files: [],
  error: null,
  session_key: `api:${SESSION_ID}`,
  workflow_kind: "deep_research",
  current_phase: "research",
  progress_message: "Running",
  progress: 0.3,
  server_seq: 1,
};

const COMPLETED_TASK = {
  ...RUNNING_TASK,
  status: "completed" as const,
  completed_at: "2026-04-20T12:03:00Z",
  output_files: [FILE_PATH],
  current_phase: "done",
  progress_message: "Complete",
  progress: 1,
  server_seq: 9,
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
        name: "Test",
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
      model: "mock",
      provider: "mock",
      uptime_secs: 1,
      agent_configured: true,
    }),
  );
  await page.route(/\/api\/sessions$/, (route) =>
    fulfillJson(route, [{ id: SESSION_ID, message_count: 0 }]),
  );
  await page.route(/\/api\/sessions\/[^/]+\/messages(?:\?.*)?$/, (route) =>
    fulfillJson(route, []),
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
  await page.route(/\/api\/sessions\/[^/]+\/events\/stream(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([]),
    });
  });

  // Shared /api/chat handler:
  //   first POST  -> research request, returns a `task_status` spawn, then
  //                  `done` with has_bg_tasks
  //   second POST -> simple follow-up, returns "Hi!" so there's a distinct
  //                  assistant bubble after the task anchor
  let chatCount = 0;
  await page.route(/\/api\/chat$/, async (route) => {
    chatCount += 1;
    const payload = JSON.parse(route.request().postData() || "{}") as {
      message?: string;
      client_message_id?: string;
    };
    if (chatCount === 1) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([
          { type: "task_status", task: RUNNING_TASK },
          {
            type: "done",
            content: `Kicking off deep research for: ${payload.message}`,
            model: "mock",
            tokens_in: 1,
            tokens_out: 1,
            duration_s: 0,
            has_bg_tasks: true,
          },
        ]),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "replace", text: "Simple answer: Hi!" },
        {
          type: "done",
          content: "Simple answer: Hi!",
          model: "mock",
          tokens_in: 1,
          tokens_out: 1,
          duration_s: 0,
          has_bg_tasks: false,
        },
      ]),
    });
  });
}

test.describe("coding-blue phase 3-4 — bug class #4 file attachment identity", () => {
  test("late file event lands on the correct task anchor, not the next bubble", async ({
    page,
  }) => {
    await installMockRuntime(page);
    await page.addInitScript((sessionId) => {
      localStorage.clear();
      localStorage.setItem("octos_session_token", "mock-token");
      localStorage.setItem("octos_auth_token", "mock-token");
      localStorage.setItem("selected_profile", "dspfac");
      localStorage.setItem("octos_current_session", sessionId);
    }, SESSION_ID);

    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    const input = page.locator(SEL.chatInput);
    const send = page.locator(SEL.sendButton);

    // Turn 1: spawn the background task.
    await input.fill("Deep research: something");
    await send.click();
    await expect(page.locator(SEL.assistantMessage)).toHaveCount(1, {
      timeout: 15_000,
    });

    // Turn 2: unrelated follow-up BEFORE the file lands. This creates a
    // second assistant bubble between the task anchor and the file event.
    await input.fill("say hi");
    await send.click();
    await expect(page.locator(SEL.assistantMessage)).toHaveCount(2, {
      timeout: 15_000,
    });

    // Now the file event arrives, carrying the tool_call_id of the task.
    await page.evaluate(
      ({ sessionId, path, filename, toolCallId, task }) => {
        // First deliver the completed task so the anchor is final.
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
        // Then dispatch a file event tied to the task's tool_call_id.
        window.dispatchEvent(
          new CustomEvent("crew:file", {
            detail: { sessionId, path, filename, caption: "", tool_call_id: toolCallId },
          }),
        );
      },
      {
        sessionId: SESSION_ID,
        path: FILE_PATH,
        filename: FILE_NAME,
        toolCallId: TOOL_CALL_ID,
        task: COMPLETED_TASK,
      },
    );

    // The task anchor must have the file.
    const anchor = page.locator(`[data-testid="task-anchor-message-${TASK_ID}"]`);
    await expect(anchor).toBeVisible({ timeout: 10_000 });
    await expect(anchor.locator(`text=${FILE_NAME}`)).toBeVisible({
      timeout: 10_000,
    });

    // And the LATER simple-answer bubble (turn 2) must NOT have the file —
    // this is the key identity assertion for bug class #4.
    const simpleAnswer = page.locator(SEL.assistantMessage).filter({
      hasText: "Simple answer: Hi!",
    });
    await expect(simpleAnswer).toHaveCount(1);
    await expect(simpleAnswer.locator(`text=${FILE_NAME}`)).toHaveCount(0);
  });
});
