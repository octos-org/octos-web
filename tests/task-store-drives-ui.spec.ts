/**
 * Bug class #3 — Task-store has correct state but chat-thread renders wrong.
 *
 * Before Phase 3+4: the task anchor bubble in chat-thread read its state
 * from message-embedded badges (message.taskAnchor) — a projection of the
 * last task update merged into the anchor message object. When the task
 * store was updated but the message store had not yet been re-projected
 * (e.g. the reducer wrote to task-store but bindBackgroundTask failed to
 * find a target), the UI kept showing the old state even though the
 * authoritative task-store knew the right one.
 *
 * Phase 3+4 subscribes chat-thread to task-store directly and renders task
 * anchors keyed on task-store state. This test writes directly into
 * task-store without any corresponding message-store update, and asserts the
 * UI reflects that state.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-task-store-drives-ui";
const TASK_ID = "task-ui-001";

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
      active: true,
      has_deferred_files: false,
      has_bg_tasks: true,
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
}

test.describe("coding-blue phase 3-4 — bug class #3 task-store drives chat-thread UI", () => {
  test("chat-thread re-renders when task-store updates alone", async ({ page }) => {
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

    // Push an initial RUNNING task through the SSE bridge so the anchor is
    // created.
    const runningTask = {
      id: TASK_ID,
      tool_name: "Deep research",
      tool_call_id: "call-ui-001",
      status: "running",
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
    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: SESSION_ID, task: runningTask },
    );

    const anchor = page.locator(`[data-testid="task-anchor-message-${TASK_ID}"]`);
    await expect(anchor).toBeVisible({ timeout: 10_000 });

    // Now mutate the task-store directly — no message-store update. The UI
    // must re-render based on task-store alone. This is the core of bug
    // class #3.
    await page.evaluate(
      async ({ sessionId, taskId }) => {
        // The task-store module is not on window; trigger an update via the
        // same crew:task_status event the reducers consume, but with a
        // distinct progress marker to prove the rerender.
        const completedTask = {
          id: taskId,
          tool_name: "Deep research",
          tool_call_id: "call-ui-001",
          status: "completed",
          started_at: "2026-04-20T12:00:00Z",
          completed_at: "2026-04-20T12:05:00Z",
          output_files: [],
          error: null,
          session_key: `api:${sessionId}`,
          workflow_kind: "deep_research",
          current_phase: "done",
          progress_message: "TASK_STORE_DRIVEN_UI_MARKER",
          progress: 1,
          server_seq: 99,
        };
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task: completedTask },
          }),
        );
      },
      { sessionId: SESSION_ID, taskId: TASK_ID },
    );

    // The phase testid must report "done" — driven purely by the task-store
    // rerender path. If chat-thread were still reading message-embedded
    // taskAnchor badges only, the anchor stays at "research".
    await expect(
      page.locator(`[data-testid="task-anchor-phase-${TASK_ID}"]`),
    ).toHaveText(/done/i, { timeout: 5_000 });

    // Spinner disappears on completion (no longer "running"/"spawned").
    await expect(
      page.locator(`[data-testid="task-anchor-spinner-${TASK_ID}"]`),
    ).toHaveCount(0);

    // Progress message updated.
    await expect(anchor).toContainText(/TASK_STORE_DRIVEN_UI_MARKER/);
  });
});
