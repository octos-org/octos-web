import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const ORIGIN_SESSION = "web-origin-deep-research";
const OTHER_SESSION = "web-other-chat";

const FAILURE_TEXT =
  'Background task "Deep research" failed. Workflow: deep_research Phase: research Join state: joined Failure action: escalate Next step: escalate to the parent session or user; do not blindly retry. Error: required tool(s) not available on this host: run_pipeline';

const FAILED_TASK = {
  id: "task-deep-research-failed",
  tool_name: "Deep research",
  tool_call_id: "call-deep-research",
  status: "failed",
  started_at: "2026-04-20T12:00:00Z",
  completed_at: "2026-04-20T12:00:05Z",
  output_files: [],
  error: FAILURE_TEXT,
  session_key: `api:${ORIGIN_SESSION}`,
  workflow_kind: "deep_research",
  current_phase: "research",
  child_join_state: "joined",
  child_failure_action: "escalate",
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
    fulfillJson(route, [
      { id: ORIGIN_SESSION, message_count: 1 },
      { id: OTHER_SESSION, message_count: 1 },
    ]),
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

  await page.route(/\/api\/sessions\/([^/]+)\/tasks(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const sessionId = decodeURIComponent(url.pathname.split("/")[3] || "");
    return fulfillJson(route, sessionId === ORIGIN_SESSION ? [FAILED_TASK] : []);
  });

  await page.route(/\/api\/sessions\/([^/]+)\/events\/stream(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const sessionId = decodeURIComponent(url.pathname.split("/")[3] || "");
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse(
        sessionId === ORIGIN_SESSION
          ? [{ type: "task_status", task: FAILED_TASK }, { type: "replay_complete" }]
          : [{ type: "replay_complete" }],
      ),
    });
  });

  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("octos_session_token", "mock-token");
    localStorage.setItem("selected_profile", "dspfac");
    localStorage.setItem("octos_current_session", "web-origin-deep-research");
  });
}

test.describe("background task scoping", () => {
  test("failed deep research task stays in its originating session", async ({ page }) => {
    await installMockRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: ORIGIN_SESSION, task: FAILED_TASK },
    );

    // Both the session-task-dock and the in-thread task-anchor bubble show
    // "Deep research failed" for the same underlying state, so resolve both
    // via first() — the assertion is that at least one is visible in the
    // originating session.
    await expect(page.getByText("Deep research failed").first()).toBeVisible();
    await expect(page.getByText(/run_pipeline/).first()).toBeVisible();

    await page
      .locator(`[data-session-id="${OTHER_SESSION}"] [data-testid="session-switch-button"]`)
      .click();

    await expect(page.getByText("Deep research failed elsewhere")).toHaveCount(0);
    await expect(page.getByText("Deep research failed")).toHaveCount(0);
    await expect(page.getByText(/run_pipeline/)).toHaveCount(0);
  });
});

