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

const COMPLETED_PROGRESS_TASK = {
  ...ACTIVE_PROGRESS_TASK,
  status: "completed",
  completed_at: "2026-04-20T12:05:00Z",
  current_phase: "deliver_result",
  lifecycle_state: "ready",
  output_files: ["pf/report.md"],
  runtime_detail: {
    ...ACTIVE_PROGRESS_TASK.runtime_detail,
    current_phase: "deliver_result",
    lifecycle_state: "ready",
  },
};

const SECOND_ACTIVE_PROGRESS_TASK = {
  ...ACTIVE_PROGRESS_TASK,
  id: "task-deep-research-active-second",
  started_at: "2026-04-20T12:01:00Z",
  current_phase: "fetch",
  runtime_detail: {
    ...ACTIVE_PROGRESS_TASK.runtime_detail,
    current_phase: "fetch",
    progress_message: "second research pass fetching sources",
    progress: 0.35,
  },
  progress_events: [
    {
      recorded_at: "2026-04-20T12:01:01Z",
      kind: "progress",
      workflow_kind: "deep_research",
      node: "search_round_1",
      tool: "web_search",
      iteration: 1,
      phase: "fetch",
      message: "second research pass fetching sources",
      progress: 0.35,
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
    tool_call_id: ACTIVE_PROGRESS_TASK.tool_call_id,
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

const HISTORY_WITH_TWO_DEEP_RESEARCH_RUNS = [
  {
    seq: 0,
    role: "user",
    content: "Deep research the first topic",
    timestamp: "2026-04-20T12:00:00.100Z",
  },
  {
    seq: 1,
    role: "assistant",
    content: "Deep research is running in the background.",
    tool_call_id: ACTIVE_PROGRESS_TASK.tool_call_id,
    timestamp: "2026-04-20T12:00:00.200Z",
  },
  {
    seq: 2,
    role: "user",
    content: "Deep research the second topic",
    timestamp: "2026-04-20T12:01:00.100Z",
  },
  {
    seq: 3,
    role: "assistant",
    content: "Deep research is running in the background.",
    tool_call_id: SECOND_ACTIVE_PROGRESS_TASK.tool_call_id,
    timestamp: "2026-04-20T12:01:00.200Z",
  },
];

const TASK_STARTED_BEFORE_TRIGGER = {
  ...ACTIVE_PROGRESS_TASK,
  id: "task-started-before-trigger-user",
  tool_call_id: "call-started-before-trigger-user",
  started_at: "2026-04-20T12:00:13.999Z",
};

const HISTORY_WITH_PRECEDING_NORMAL_TURNS = [
  {
    seq: 0,
    role: "user",
    content: "What is your name?",
    timestamp: "2026-04-20T12:00:00.000Z",
  },
  {
    seq: 1,
    role: "user",
    content: "What is the weather here?",
    timestamp: "2026-04-20T12:00:05.000Z",
  },
  {
    seq: 2,
    role: "assistant",
    content: "I am Octos.",
    timestamp: "2026-04-20T12:00:05.100Z",
  },
  {
    seq: 3,
    role: "user",
    content: "Deep research Iran and US reconciliation",
    timestamp: "2026-04-20T12:00:14.000Z",
  },
  {
    seq: 4,
    role: "assistant",
    content: "Deep research is running in the background.",
    tool_call_id: TASK_STARTED_BEFORE_TRIGGER.tool_call_id,
    timestamp: "2026-04-20T12:00:14.001Z",
  },
  {
    seq: 5,
    role: "assistant",
    content: "Please provide your city name.",
    timestamp: "2026-04-20T12:00:16.000Z",
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
  firstChatEvents?: unknown[],
  messageDelayMs = 0,
  secondChatEvents?: unknown[],
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

  await page.route(/\/api\/sessions\/([^/]+)\/messages(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const sessionId = decodeURIComponent(url.pathname.split("/")[3] || "");
    if (messageDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, messageDelayMs));
    }
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
          ? (firstChatEvents ?? [
              {
                type: "replace",
                text: "Deep research is running in the background.",
                tool_call_id: ACTIVE_PROGRESS_TASK.tool_call_id,
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
                bg_tasks: [ACTIVE_PROGRESS_TASK],
              },
            ])
          : (secondChatEvents ?? [
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
            ]),
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
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-message-type",
      "background_task",
    );
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-message-status",
      "ongoing",
    );
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
    await expect(
      page
        .locator("[data-testid='assistant-message']")
        .filter({ hasText: "Here is the normal follow-up response." }),
    ).toBeVisible();
    await expect(page.getByTestId("task-anchor-message")).not.toContainText(
      "Here is the normal follow-up response.",
    );
  });

  test("has_bg_tasks without task identity does not create a task bubble", async ({
    page,
  }) => {
    await installMockRuntime(page, [], [], {}, [
      {
        type: "replace",
        text: "The weather is clear.",
      },
      {
        type: "done",
        content: "The weather is clear.",
        model: "mock-model",
        tokens_in: 1,
        tokens_out: 1,
        duration_s: 1,
        has_bg_tasks: true,
      },
    ]);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await getInput(page).fill("What is the weather?");
    await getSendButton(page).click();

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(0);
    await expect(page.getByTestId("assistant-message").last()).toHaveAttribute(
      "data-message-type",
      "assistant",
    );
    await expect(page.getByTestId("assistant-message").last()).toContainText(
      "The weather is clear.",
    );
  });

  test("done bg_tasks without a real task id does not create a task bubble", async ({
    page,
  }) => {
    await installMockRuntime(page, [], [], {}, [
      {
        type: "replace",
        text: "The weather is clear.",
      },
      {
        type: "done",
        content: "The weather is clear.",
        model: "mock-model",
        tokens_in: 1,
        tokens_out: 1,
        duration_s: 1,
        has_bg_tasks: true,
        bg_tasks: [
          {
            ...ACTIVE_PROGRESS_TASK,
            id: "",
          },
        ],
      },
    ]);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await getInput(page).fill("What is the weather?");
    await getSendButton(page).click();

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(0);
    await expect(page.getByTestId("assistant-message").last()).toHaveAttribute(
      "data-message-type",
      "assistant",
    );
    await expect(page.getByTestId("assistant-message").last()).toContainText(
      "The weather is clear.",
    );
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

    await expect(page.getByTestId("session-task-label")).toHaveCount(0);
    await expect(page.getByTestId("session-task-detail")).toHaveCount(0);
    await expect(page.getByTestId("task-anchor-label")).toContainText(
      "Deep research running",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "node search_round_2",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "tool web_fetch",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "iter 2",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "phase fetch",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "Fetching 4 pages in parallel...",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "node search_round_1",
    );
    await expect(page.getByTestId("task-anchor-detail")).toContainText(
      "Searching: \"rust async\"",
    );
    await expect(page.getByTestId("task-anchor-detail")).not.toContainText(
      "Background work continues independently",
    );
  });

  test("live task status and later causal ack coalesce by explicit task id", async ({
    page,
  }) => {
    const racedTask = {
      ...ACTIVE_PROGRESS_TASK,
      id: "task-live-race",
      tool_call_id: "call-live-race",
    };
    await installMockRuntime(page, [], [], {}, [
      { type: "task_status", task: racedTask },
      {
        type: "replace",
        text: "Deep research is running in the background.",
        tool_call_id: racedTask.tool_call_id,
      },
      {
        type: "done",
        content: "Deep research is running in the background.",
        model: "mock-model",
        tokens_in: 1,
        tokens_out: 1,
        duration_s: 1,
        has_bg_tasks: true,
        bg_tasks: [racedTask],
      },
    ]);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await getInput(page).fill("Start the deep research task");
    await getSendButton(page).click();

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await expect(page.getByTestId("task-anchor-label")).toContainText(
      "Deep research running",
    );
    await expect(page.getByTestId("task-anchor-message")).not.toContainText(
      "Deep research is running in the background.",
    );
    await expect(page.getByTestId("assistant-message")).toHaveCount(1);
    await expect(page.getByTestId("assistant-message")).toContainText(
      "Deep research is running in the background.",
    );
  });

  test("normal reply during existing background work stays a normal assistant bubble", async ({
    page,
  }) => {
    await installMockRuntime(page, [ACTIVE_PROGRESS_TASK], [], {}, [
      {
        type: "replace",
        text: "I am Octos.",
      },
      {
        type: "done",
        content: "I am Octos.",
        model: "mock-model",
        tokens_in: 1,
        tokens_out: 1,
        duration_s: 1,
        has_bg_tasks: true,
      },
    ]);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-message-status",
      "ongoing",
    );

    await getInput(page).fill("What is your name?");
    await getSendButton(page).click();

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await expect(page.getByTestId("assistant-message").last()).toHaveAttribute(
      "data-message-type",
      "assistant",
    );
    await expect(page.getByTestId("assistant-message").last()).toHaveAttribute(
      "data-message-status",
      "completed",
    );
    await expect(page.getByTestId("assistant-message").last()).toContainText(
      "I am Octos.",
    );
    await expect(page.getByTestId("task-anchor-message").last()).not.toContainText(
      "I am Octos.",
    );
  });

  test("completed old task cannot attach to later cron weather or name answers", async ({
    page,
  }) => {
    await installMockRuntime(
      page,
      [COMPLETED_PROGRESS_TASK],
      [],
      {
        [ORIGIN_SESSION]: HISTORY_WITH_LATER_NORMAL_TURNS,
      },
      [
        {
          type: "replace",
          text: "You have no scheduled tasks.",
        },
        {
          type: "done",
          content: "You have no scheduled tasks.",
          model: "mock-model",
          tokens_in: 1,
          tokens_out: 1,
          duration_s: 1,
          has_bg_tasks: true,
        },
      ],
    );
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await getInput(page).fill("Do I have scheduled tasks?");
    await getSendButton(page).click();

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-task-id",
      COMPLETED_PROGRESS_TASK.id,
    );
    await expect(page.getByTestId("task-anchor-message")).not.toContainText(
      "You have no scheduled tasks.",
    );
    await expect(page.getByTestId("assistant-message").last()).toContainText(
      "You have no scheduled tasks.",
    );
  });

  test("tool chips close when stream completes without tool_end", async ({ page }) => {
    await installMockRuntime(page, [], [], {}, [
      {
        type: "tool_start",
        tool: "news_fetch",
        tool_call_id: "call-news-fetch",
      },
      {
        type: "replace",
        text: "Here is the news summary.",
      },
      {
        type: "done",
        content: "Here is the news summary.",
        model: "mock-model",
        tokens_in: 1,
        tokens_out: 1,
        duration_s: 1,
        has_bg_tasks: false,
      },
    ]);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await getInput(page).fill("Fetch the news");
    await getSendButton(page).click();

    await expect(page.getByTestId("assistant-message").last()).toHaveAttribute(
      "data-message-status",
      "completed",
    );
    const toolChip = page
      .getByTestId("assistant-message")
      .last()
      .locator("text=news_fetch");
    await expect(toolChip).toBeVisible();
    await expect(toolChip).not.toHaveClass(/animate-pulse/u);
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

    await expect(page.getByTestId("session-task-label")).toHaveCount(0);
    await expect(page.getByTestId("session-task-detail")).toHaveCount(0);
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

  test("reloaded task anchor remains task-id scoped after later normal turns", async ({
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
    expect(taskIndex).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-task-id",
      ACTIVE_PROGRESS_TASK.id,
    );
    await expect(page.getByTestId("task-anchor-message")).not.toContainText(
      "The weather is clear.",
    );
    await expect(page.getByTestId("task-anchor-message")).not.toContainText("Octos");

    await page
      .locator(`[data-session-id="${OTHER_SESSION}"] [data-testid="session-switch-button"]`)
      .click();
    await page
      .locator(`[data-session-id="${ORIGIN_SESSION}"] [data-testid="session-switch-button"]`)
      .click();
    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);

    rows = await timeline();
    taskIndex = rows.findIndex((row) => row.kind === "task-anchor-message");
    expect(taskIndex).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-task-id",
      ACTIVE_PROGRESS_TASK.id,
    );
    await expect(page.getByTestId("task-anchor-message")).not.toContainText(
      "The weather is clear.",
    );
    await expect(page.getByTestId("task-anchor-message")).not.toContainText("Octos");
  });

  test("task anchor survives when /tasks replay beats /messages history", async ({
    page,
  }) => {
    await installMockRuntime(
      page,
      [ACTIVE_PROGRESS_TASK],
      [],
      {
        [ORIGIN_SESSION]: HISTORY_WITH_LATER_NORMAL_TURNS,
      },
      undefined,
      1_000,
    );
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await expect(page.getByTestId("task-anchor-label")).toContainText(
      "Deep research running",
    );
    await expect(page.getByTestId("task-anchor-message")).not.toContainText(
      "Deep research is running in the background.",
    );
    await expect(page.getByTestId("assistant-message").first()).toContainText(
      "Deep research is running in the background.",
    );
  });

  test("repeated deep research ACK streams create bubbles only from distinct task ids", async ({
    page,
  }) => {
    await installMockRuntime(
      page,
      [],
      [],
      {},
      [
        {
          type: "replace",
          text: "Deep research is running in the background.",
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
          bg_tasks: [ACTIVE_PROGRESS_TASK],
        },
      ],
      0,
      [
        {
          type: "replace",
          text: "Deep research is running in the background.",
          tool_call_id: SECOND_ACTIVE_PROGRESS_TASK.tool_call_id,
        },
        {
          type: "done",
          content: "Deep research is running in the background.",
          model: "mock-model",
          tokens_in: 1,
          tokens_out: 1,
          duration_s: 1,
          has_bg_tasks: true,
          bg_tasks: [SECOND_ACTIVE_PROGRESS_TASK],
        },
      ],
    );
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await getInput(page).fill("Deep research the first topic");
    await getSendButton(page).click();
    await getInput(page).fill("Deep research the second topic");
    await getSendButton(page).click();

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(2);
    await expect(page.getByTestId("task-anchor-message").first()).toHaveAttribute(
      "data-task-id",
      ACTIVE_PROGRESS_TASK.id,
    );
    await expect(page.getByTestId("task-anchor-message").last()).toHaveAttribute(
      "data-task-id",
      SECOND_ACTIVE_PROGRESS_TASK.id,
    );
    await expect(page.getByTestId("assistant-message")).toHaveCount(2);
    await expect(page.getByTestId("assistant-message").first()).toContainText(
      "Deep research is running in the background.",
    );
    await expect(page.getByTestId("assistant-message").last()).toContainText(
      "Deep research is running in the background.",
    );
  });

  test("repeated deep research runs keep separate status bubbles", async ({
    page,
  }) => {
    await installMockRuntime(
      page,
      [ACTIVE_PROGRESS_TASK, SECOND_ACTIVE_PROGRESS_TASK],
      [ACTIVE_PROGRESS_TASK, SECOND_ACTIVE_PROGRESS_TASK],
      {
        [ORIGIN_SESSION]: HISTORY_WITH_TWO_DEEP_RESEARCH_RUNS,
      },
    );
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(2);
    await expect(page.getByTestId("task-anchor-message").first()).toHaveAttribute(
      "data-task-id",
      ACTIVE_PROGRESS_TASK.id,
    );
    await expect(page.getByTestId("task-anchor-message").last()).toHaveAttribute(
      "data-task-id",
      SECOND_ACTIVE_PROGRESS_TASK.id,
    );
    await expect(page.getByTestId("task-anchor-detail").last()).toContainText(
      "second research pass fetching sources",
    );
  });

  test("completed task replay renders completed per-message status without spinner", async ({
    page,
  }) => {
    await installMockRuntime(page, [COMPLETED_PROGRESS_TASK], [], {
      [ORIGIN_SESSION]: HISTORY_WITH_LATER_NORMAL_TURNS,
    });
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    await expect(page.getByTestId("task-anchor-message")).toHaveCount(1);
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-message-type",
      "background_task",
    );
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-message-status",
      "completed",
    );
    await expect(page.getByTestId("task-anchor-label")).toContainText(
      "Deep research completed",
    );
    await expect(page.getByTestId("task-anchor-spinner")).toHaveCount(0);
  });

  test("task created just before trigger user does not attach to previous normal turn", async ({
    page,
  }) => {
    await installMockRuntime(page, [TASK_STARTED_BEFORE_TRIGGER], [], {
      [ORIGIN_SESSION]: HISTORY_WITH_PRECEDING_NORMAL_TURNS,
    });
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    const timelineSelector = [
      "[data-testid='chat-thread'] [data-testid='user-message']",
      "[data-testid='chat-thread'] [data-testid='assistant-message']",
      "[data-testid='chat-thread'] [data-testid='task-anchor-message']",
    ].join(", ");
    const rows = await page.locator(timelineSelector).evaluateAll((elements) =>
      elements.map((element) => ({
        kind: element.getAttribute("data-testid"),
        text: element.textContent ?? "",
      })),
    );

    const taskIndex = rows.findIndex((row) => row.kind === "task-anchor-message");
    const weatherIndex = rows.findIndex((row) =>
      row.text.includes("What is the weather here?"),
    );
    const weatherAnswerIndex = rows.findIndex((row) =>
      row.text.includes("Please provide your city name."),
    );

    expect(taskIndex).toBeGreaterThan(weatherIndex);
    expect(taskIndex).toBeLessThan(weatherAnswerIndex);
    await expect(page.getByTestId("task-anchor-message")).toHaveAttribute(
      "data-task-id",
      TASK_STARTED_BEFORE_TRIGGER.id,
    );
    await expect(page.getByTestId("task-anchor-message")).not.toContainText(
      "Please provide your city name.",
    );
  });
});
