/**
 * B-006 — task-anchor UI a11y.
 *
 * The task anchor bubble is a live status surface — it flips between
 * running/completed/failed states as background tasks progress. Before
 * this fix it had zero a11y metadata: no `role`, no `aria-live`, no
 * `aria-label`. Screen readers saw an ordinary `<div>` with changing
 * text content and no announcement semantics.
 *
 * Post-fix:
 *   - outer bubble: role="status" + aria-live="polite" + non-empty
 *     aria-label composed of toolName + phase + progressMessage
 *   - spinner: aria-hidden="true"
 *   - inline progress %: role="progressbar" + aria-valuenow/min/max
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-task-anchor-a11y";
const TASK_ID = "task-a11y-001";

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
      body: "",
    });
  });
}

test.describe("B-006 — task-anchor bubble a11y", () => {
  test("running task anchor has role=status, aria-live=polite, non-empty aria-label, hidden spinner", async ({
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

    // Render a running task anchor bubble via the crew:task_status path.
    await page.evaluate(
      ({ sessionId, taskId }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: {
              sessionId,
              task: {
                id: taskId,
                tool_name: "Deep research",
                tool_call_id: "call-a11y-001",
                status: "running",
                started_at: "2026-04-20T12:00:00Z",
                completed_at: null,
                output_files: [],
                error: null,
                session_key: `api:${sessionId}`,
                current_phase: "synthesize",
                progress_message: "Gathering sources",
                progress: 0.42,
              },
              server_seq: 3,
              updated_at: "2026-04-20T12:00:05Z",
            },
          }),
        );
      },
      { sessionId: SESSION_ID, taskId: TASK_ID },
    );

    const bubble = page.locator(`[data-testid="task-anchor-message-${TASK_ID}"]`);
    await expect(bubble).toBeVisible({ timeout: 10_000 });

    // Outer bubble a11y attributes.
    await expect(bubble).toHaveAttribute("role", "status");
    await expect(bubble).toHaveAttribute("aria-live", "polite");
    const label = await bubble.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toContain("Deep research");
    expect(label).toContain("synthesize");
    expect(label).toContain("Gathering sources");

    // Spinner is aria-hidden.
    const spinner = page.locator(`[data-testid="task-anchor-spinner-${TASK_ID}"]`);
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveAttribute("aria-hidden", "true");

    // Progress % has progressbar semantics.
    const progressBar = bubble.locator('[role="progressbar"]').first();
    await expect(progressBar).toBeVisible();
    await expect(progressBar).toHaveAttribute("aria-valuenow", "42");
    await expect(progressBar).toHaveAttribute("aria-valuemin", "0");
    await expect(progressBar).toHaveAttribute("aria-valuemax", "100");
  });

  test("completed task anchor keeps role=status and has completion in aria-label", async ({
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

    await page.evaluate(
      ({ sessionId, taskId }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: {
              sessionId,
              task: {
                id: taskId,
                tool_name: "Deep research",
                tool_call_id: "call-a11y-002",
                status: "completed",
                started_at: "2026-04-20T12:00:00Z",
                completed_at: "2026-04-20T12:01:00Z",
                output_files: [],
                error: null,
                session_key: `api:${sessionId}`,
                current_phase: "done",
                progress_message: null,
                progress: 1,
              },
              server_seq: 9,
              updated_at: "2026-04-20T12:01:00Z",
            },
          }),
        );
      },
      { sessionId: SESSION_ID, taskId: TASK_ID },
    );

    const bubble = page.locator(`[data-testid="task-anchor-message-${TASK_ID}"]`);
    await expect(bubble).toBeVisible({ timeout: 10_000 });
    await expect(bubble).toHaveAttribute("role", "status");
    await expect(bubble).toHaveAttribute("aria-live", "polite");
    const label = await bubble.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toContain("completed");
    // Completed tasks do not render a spinner, so the aria-hidden
    // requirement has nothing to attach to — that's fine.
  });
});
