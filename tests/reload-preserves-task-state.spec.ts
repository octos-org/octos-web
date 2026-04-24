/**
 * Bug class #1 — Reload during active deep research.
 *
 * Before coding-blue Phase 3+4: during an active background task, reloading
 * the page lost the task spinner because the task state lived only in
 * component-local React state (via message-store notifications). After reload
 * the client waited on fresh SSE + polling before any UI could appear, and
 * the task anchor bubble that marked "deep research in progress" would not
 * come back until both the session message stream and the task-watcher
 * converged. In practice the spinner simply disappeared.
 *
 * Phase 3+4 persists task-store to localStorage keyed on profile + session
 * and rehydrates on page load. This test drives a reload-during-active-task
 * scenario and asserts that the task anchor bubble (identified by
 * data-testid="task-anchor-message-<task_id>") is present after reload,
 * before the fresh poll or SSE has a chance to reinstate it.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-reload-deep-research";
const ACTIVE_TASK = {
  id: "task-reload-active-001",
  tool_name: "Deep research",
  tool_call_id: "call-reload-active-001",
  status: "running" as const,
  started_at: "2026-04-20T12:00:00Z",
  completed_at: null,
  output_files: [],
  error: null,
  session_key: `api:${SESSION_ID}`,
  workflow_kind: "deep_research",
  current_phase: "research",
  progress_message: "Gathering sources",
  progress: 0.4,
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

async function installMockRuntime(
  page: Page,
  opts: { tasksAfterReload?: unknown[]; seedFirstLoad?: boolean } = {},
) {
  const taskList = opts.tasksAfterReload ?? [ACTIVE_TASK];

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
    fulfillJson(route, [{ id: SESSION_ID, message_count: 1 }]),
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
    fulfillJson(route, taskList),
  );
  // Event stream holds open briefly, delivering nothing — simulates the
  // reload scenario where the server is still working but the client has
  // not yet reestablished the live stream.
  await page.route(/\/api\/sessions\/[^/]+\/events\/stream(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([]),
    });
  });
}

test.describe("coding-blue phase 3-4 — bug class #1 reload preserves task state", () => {
  test("task-store persists + rehydrates across reload so task anchor survives", async ({
    page,
  }) => {
    await installMockRuntime(page);

    // Seed auth/profile/session in localStorage WITHOUT clearing it — the
    // reload path below must be able to read the persisted task-store entry
    // that the first page write flushed there.
    await page.addInitScript((sessionId) => {
      localStorage.setItem("octos_session_token", "mock-token");
      localStorage.setItem("octos_auth_token", "mock-token");
      localStorage.setItem("selected_profile", "dspfac");
      localStorage.setItem("octos_current_session", sessionId);
    }, SESSION_ID);

    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    // Dispatch a task_status event so the task-store is populated and the
    // task anchor is rendered. This is the state the server would push during
    // an active deep research run.
    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: SESSION_ID, task: ACTIVE_TASK },
    );

    // The task anchor must appear.
    await expect(
      page.locator(`[data-testid="task-anchor-message-${ACTIVE_TASK.id}"]`),
    ).toBeVisible({ timeout: 10_000 });

    // B-005: NO waitForTimeout here. The pagehide/visibilitychange flush
    // (registered on module load) must synchronously persist the task
    // slice when the reload begins, even inside the 250 ms debounce
    // window. If this test requires a timeout to pass, bug class #1 is
    // still latent.
    await installMockRuntime(page, { tasksAfterReload: [] });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(SEL.chatInput);

    // Sanity-check from the POST-reload side: the persisted entry made it
    // to localStorage BEFORE the network arrived to repopulate the store.
    const persistedAfterReload = await page.evaluate((sessionId) => {
      const key = `octos_web:task_store:v1:dspfac:${sessionId}`;
      return localStorage.getItem(key);
    }, SESSION_ID);
    expect(persistedAfterReload).not.toBeNull();
    expect(persistedAfterReload).toContain(ACTIVE_TASK.id);

    // The anchor must still be on screen before any network recovery — the
    // persisted task-store entry is the only thing that can supply it.
    await expect(
      page.locator(`[data-testid="task-anchor-message-${ACTIVE_TASK.id}"]`),
    ).toBeVisible({ timeout: 5_000 });

    // And the spinner testid must be present because the task is still
    // running per the rehydrated state.
    await expect(
      page.locator(`[data-testid="task-anchor-spinner-${ACTIVE_TASK.id}"]`),
    ).toBeVisible({ timeout: 5_000 });
  });
});
