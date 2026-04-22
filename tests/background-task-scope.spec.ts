import { expect, test, type Page, type Route } from "@playwright/test";
import { getInput, getSendButton, SEL } from "./helpers";

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

const ACTIVE_PROGRESS_TASK = {
  id: "task-deep-research-active",
  tool_name: "Deep research",
  tool_call_id: "call-deep-research-active",
  status: "running",
  started_at: "2026-04-20T12:00:00Z",
  completed_at: null,
  output_files: [],
  error: null,
  session_key: `api:${ORIGIN_SESSION}`,
  workflow_kind: "deep_research",
  current_phase: "search",
  runtime_detail: {
    schema: "octos.harness.event.v1",
    kind: "progress",
    workflow_kind: "deep_research",
    current_phase: "search",
    progress_message:
      "search_task_0 [minimax@open/MiniMax-M2.5-highspeed]: response received (iteration 1)",
    progress: 0.25,
  },
  progress_events: [
    {
      recorded_at: "2026-04-20T12:00:01Z",
      kind: "progress",
      workflow_kind: "deep_research",
      node: "search_round_1",
      tool: "web_search",
      iteration: 1,
      phase: "search",
      message: 'Searching: "rust async"',
      progress: 0.25,
    },
    {
      recorded_at: "2026-04-20T12:00:02Z",
      kind: "phase",
      workflow_kind: "deep_research",
      node: "search_round_2",
      tool: "web_fetch",
      iteration: 2,
      phase: "fetch",
      message: "Fetching 4 pages in parallel...",
      progress: 0.5,
    },
  ],
};

const HISTORY_WITH_LATER_NORMAL_TURNS = [
  {
    seq: 0,
    role: "user",
    content: "Start the deep research task",
    timestamp: "2026-04-20T12:00:00.100Z",
  },
  {
    seq: 1,
    role: "assistant",
    content: "Deep research is running in the background.",
    timestamp: "2026-04-20T12:00:00.200Z",
  },
  {
    seq: 2,
    role: "user",
    content: "What is the weather today?",
    timestamp: "2026-04-20T12:00:15.000Z",
  },
  {
    seq: 3,
    role: "assistant",
    content: "The weather is clear.",
    timestamp: "2026-04-20T12:00:18.000Z",
  },
  {
    seq: 4,
    role: "user",
    content: "What is your name?",
    timestamp: "2026-04-20T12:00:20.000Z",
  },
  {
    seq: 5,
    role: "assistant",
    content: "Octos",
    timestamp: "2026-04-20T12:00:22.000Z",
  },
];

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
  originTasks: unknown[] = [],
  streamTasks: unknown[] = originTasks,
  messagesBySession: Record<string, unknown[]> = {},
) {
  let chatCount = 0;

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

  await page.route(/\/api\/sessions\/([^/]+)\/messages(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const sessionId = decodeURIComponent(url.pathname.split("/")[3] || "");
    return fulfillJson(route, messagesBySession[sessionId] ?? []);
  });

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
    return fulfillJson(route, sessionId === ORIGIN_SESSION ? originTasks : []);
  });

  await page.route(/\/api\/sessions\/([^/]+)\/events\/stream(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const sessionId = decodeURIComponent(url.pathname.split("/")[3] || "");
    if (sessionId === ORIGIN_SESSION && originTasks.length > 0 && streamTasks.length === 0) {
      return route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "stream replay intentionally omitted",
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse(
        sessionId === ORIGIN_SESSION
          ? [
              ...streamTasks.map((task) => ({ type: "task_status", task })),
              { type: "replay_complete" },
            ]
          : [{ type: "replay_complete" }],
      ),
    });
  });

  await page.route(/\/api\/chat$/, async (route) => {
    chatCount += 1;
    const firstTurn = chatCount === 1;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse(
        firstTurn
          ? [
              {
                type: "replace",
                text: "Deep research is running in the background.",
              },
              {
                type: "tool_start",
                tool: "Deep research",
                tool_call_id: ACTIVE_PROGRESS_TASK.tool_call_id,
              },
              {
                type: "done",
                content: "Deep research is running in the background.",
                model: "mock-model",
                tokens_in: 1,
                tokens_out: 1,
                duration_s: 1,
                has_bg_tasks: true,
              },
            ]
          : [
              {
                type: "replace",
                text: "Here is the normal follow-up response.",
              },
              {
                type: "done",
                content: "Here is the normal follow-up response.",
                model: "mock-model",
                tokens_in: 1,
                tokens_out: 1,
                duration_s: 1,
                has_bg_tasks: false,
              },
            ],
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
  test("task anchor survives a later assistant message", async ({ page }) => {
    await installMockRuntime(page);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await getInput(page).fill("Start the deep research task");
    await getSendButton(page).click();

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);

    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: ORIGIN_SESSION, task: ACTIVE_PROGRESS_TASK },
    );

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await expect(page.getByTestId("task-anchor-message")).toBeVisible();
    await expect(page.getByTestId("task-anchor-label")).toContainText(
      "Deep research running",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "Searching: \"rust async\"",
    );

    await page.waitForTimeout(3_000);
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "Searching: \"rust async\"",
    );

    await getInput(page).fill("Give me a normal follow-up");
    await getSendButton(page).click();

    await expect(page.getByTestId("task-anchor-message")).toBeVisible();
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "Searching: \"rust async\"",
    );
    await expect(page.locator("[data-testid='assistant-message']")).toHaveCount(1);
  });

  test("active deep research task shows structured progress detail", async ({ page }) => {
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
      { sessionId: ORIGIN_SESSION, task: ACTIVE_PROGRESS_TASK },
    );

    await expect(page.getByTestId("session-task-label")).toContainText(
      "Deep research running",
    );
    await expect(page.getByTestId("session-task-detail")).toContainText(
      "node search_round_2",
    );
    await expect(page.getByTestId("session-task-detail")).toContainText(
      "tool web_fetch",
    );
    await expect(page.getByTestId("session-task-detail")).toContainText(
      "iter 2",
    );
    await expect(page.getByTestId("session-task-detail")).toContainText(
      "phase fetch",
    );
    await expect(page.getByTestId("session-task-detail")).toContainText(
      "Fetching 4 pages in parallel...",
    );
    await expect(page.getByTestId("session-task-detail")).toContainText(
      "node search_round_1",
    );
    await expect(page.getByTestId("session-task-detail")).toContainText(
      "Searching: \"rust async\"",
    );
    await expect(page.getByTestId("session-task-detail")).not.toContainText(
      "Background work continues independently",
    );
  });

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

    await expect(page.getByTestId("session-task-label")).toContainText(
      "Deep research failed",
    );
    await expect(page.getByTestId("session-task-detail")).toContainText(
      "run_pipeline",
    );
    await expect(page.getByTestId("task-anchor-label")).toContainText(
      "Deep research failed",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "run_pipeline",
    );

    await page
      .locator(`[data-session-id="${OTHER_SESSION}"] [data-testid="session-switch-button"]`)
      .click();

    await expect(page.getByTestId("task-anchor-label")).toHaveCount(0);
    await expect(page.getByTestId("task-anchor-detail")).toHaveCount(0);
  });

  test("task anchor reconstructs after reload from /tasks", async ({ page }) => {
    await installMockRuntime(page, [ACTIVE_PROGRESS_TASK], []);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.getByTestId("task-anchor-message")).toBeVisible();
    await expect(page.getByTestId("task-anchor-label")).toContainText(
      "Deep research running",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "Searching: \"rust async\"",
    );

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.getByTestId("task-anchor-message")).toBeVisible();
    await expect(page.getByTestId("task-anchor-label")).toContainText(
      "Deep research running",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "Searching: \"rust async\"",
    );
  });

  test("reloaded task anchor stays at the originating turn after later normal turns", async ({
    page,
  }) => {
    await installMockRuntime(page, [ACTIVE_PROGRESS_TASK], [], {
      [ORIGIN_SESSION]: HISTORY_WITH_LATER_NORMAL_TURNS,
    });
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    const timelineSelector = [
      "[data-testid='chat-thread'] [data-testid='user-message']",
      "[data-testid='chat-thread'] [data-testid='assistant-message']",
      "[data-testid='chat-thread'] [data-testid='task-anchor-message']",
    ].join(", ");
    const timeline = async () =>
      page.locator(timelineSelector).evaluateAll((elements) =>
        elements.map((element) => ({
          kind: element.getAttribute("data-testid"),
          text: element.textContent ?? "",
        })),
      );

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    let rows = await timeline();
    let taskIndex = rows.findIndex((row) => row.kind === "task-anchor-message");
    let backgroundAckIndex = rows.findIndex((row) =>
      row.text.includes("Deep research is running in the background."),
    );
    let weatherIndex = rows.findIndex((row) =>
      row.text.includes("What is the weather today?"),
    );
    expect(taskIndex).toBeGreaterThanOrEqual(backgroundAckIndex);
    expect(taskIndex).toBeLessThan(weatherIndex);

    await page
      .locator(`[data-session-id="${OTHER_SESSION}"] [data-testid="session-switch-button"]`)
      .click();
    await page
      .locator(`[data-session-id="${ORIGIN_SESSION}"] [data-testid="session-switch-button"]`)
      .click();
    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);

    rows = await timeline();
    taskIndex = rows.findIndex((row) => row.kind === "task-anchor-message");
    backgroundAckIndex = rows.findIndex((row) =>
      row.text.includes("Deep research is running in the background."),
    );
    weatherIndex = rows.findIndex((row) =>
      row.text.includes("What is the weather today?"),
    );
    expect(taskIndex).toBeGreaterThanOrEqual(backgroundAckIndex);
    expect(taskIndex).toBeLessThan(weatherIndex);
  });
});
