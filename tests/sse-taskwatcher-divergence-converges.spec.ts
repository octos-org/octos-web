/**
 * Bug class #2 — SSE + task-watcher + history replay disagree.
 *
 * Before Phase 3+4: the three update sources (main /api/chat SSE, the
 * /events/stream task-watcher, and history replay via /messages) each wrote
 * directly to the message store with their own shape. When two sources
 * reported divergent progress for the same task, the UI flickered between
 * them or locked onto the first one arrive and ignored later updates.
 *
 * Phase 3+4 routes every update through background-task-reducer, and the
 * reducer picks the highest server_seq (else the most recent updated_at).
 * This test feeds the client two conflicting progress snapshots for the same
 * task — one via the SSE bridge, one via the task-watcher stream — and
 * asserts that the UI converges on the newer one instead of oscillating.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-sse-taskwatcher-converge";
const TASK_ID = "task-converge-001";

type TaskSnapshot = {
  id: string;
  tool_name: string;
  tool_call_id: string;
  status: "spawned" | "running" | "completed" | "failed";
  started_at: string;
  completed_at: string | null;
  output_files: string[];
  error: string | null;
  session_key: string;
  workflow_kind: string;
  current_phase: string;
  progress_message: string;
  progress: number;
  server_seq?: number;
  updated_at?: string;
};

const OLDER_SNAPSHOT: TaskSnapshot = {
  id: TASK_ID,
  tool_name: "Deep research",
  tool_call_id: "call-converge-001",
  status: "running",
  started_at: "2026-04-20T12:00:00Z",
  completed_at: null,
  output_files: [],
  error: null,
  session_key: `api:${SESSION_ID}`,
  workflow_kind: "deep_research",
  current_phase: "research",
  progress_message: "OLDER_PROGRESS_A",
  progress: 0.2,
  server_seq: 1,
  updated_at: "2026-04-20T12:00:05Z",
};

const NEWER_SNAPSHOT: TaskSnapshot = {
  ...OLDER_SNAPSHOT,
  current_phase: "synthesize",
  progress_message: "NEWER_PROGRESS_B",
  progress: 0.75,
  server_seq: 9,
  updated_at: "2026-04-20T12:05:00Z",
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
    fulfillJson(route, [OLDER_SNAPSHOT]),
  );
  await page.route(/\/api\/sessions\/[^/]+\/events\/stream(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([]),
    });
  });
}

test.describe("coding-blue phase 3-4 — bug class #2 sse + task-watcher converge", () => {
  test("newer server_seq wins even when older snapshot arrives last", async ({ page }) => {
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

    // Source A: SSE bridge delivers the NEWER snapshot first.
    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: SESSION_ID, task: NEWER_SNAPSHOT },
    );
    // Source B: task-watcher delivers the OLDER snapshot afterwards. Under the
    // pre-fix code this would overwrite the newer state. Under Phase 3+4 the
    // reducer picks the higher server_seq and ignores this update.
    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: SESSION_ID, task: OLDER_SNAPSHOT },
    );

    // Anchor appears.
    const anchor = page.locator(`[data-testid="task-anchor-message-${TASK_ID}"]`);
    await expect(anchor).toBeVisible({ timeout: 10_000 });

    // The phase testid must report the NEWER phase — not flip back to
    // research/OLDER_PROGRESS_A. This is the core convergence assertion.
    const phase = page.locator(`[data-testid="task-anchor-phase-${TASK_ID}"]`);
    await expect(phase).toHaveText(/synthesize/i, { timeout: 5_000 });

    // Short text/progress check: the newer progress message wins.
    await expect(anchor).toContainText(/NEWER_PROGRESS_B/);
    await expect(anchor).not.toContainText(/OLDER_PROGRESS_A/);
  });

  test("equal server_seq: newer updated_at wins (B-004 tiebreak + B-010 guard)", async ({
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

    const EQUAL_SEQ = 5;
    const FIRST_SNAPSHOT = {
      ...OLDER_SNAPSHOT,
      progress_message: "EQUAL_SEQ_FIRST_OLDER",
      progress: 0.3,
      server_seq: EQUAL_SEQ,
      updated_at: "2026-04-20T12:00:05Z",
    };
    const SECOND_SNAPSHOT = {
      ...OLDER_SNAPSHOT,
      current_phase: "synthesize",
      progress_message: "EQUAL_SEQ_SECOND_NEWER",
      progress: 0.85,
      server_seq: EQUAL_SEQ,
      updated_at: "2026-04-20T12:05:00Z",
    };

    // First write establishes the existing snapshot at the equal seq.
    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: SESSION_ID, task: FIRST_SNAPSHOT },
    );
    // Second write: same seq, strictly newer updated_at → must win.
    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: SESSION_ID, task: SECOND_SNAPSHOT },
    );

    const anchor = page.locator(`[data-testid="task-anchor-message-${TASK_ID}"]`);
    await expect(anchor).toBeVisible({ timeout: 10_000 });
    await expect(anchor).toContainText(/EQUAL_SEQ_SECOND_NEWER/);
    await expect(anchor).not.toContainText(/EQUAL_SEQ_FIRST_OLDER/);

    // Now try the reverse: send a third snapshot with the same seq but an
    // OLDER updated_at. It must be rejected; the second snapshot still
    // drives the UI.
    const THIRD_STALE = {
      ...OLDER_SNAPSHOT,
      current_phase: "research",
      progress_message: "EQUAL_SEQ_THIRD_STALE",
      progress: 0.1,
      server_seq: EQUAL_SEQ,
      updated_at: "2026-04-20T11:00:00Z",
    };
    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { sessionId, task },
          }),
        );
      },
      { sessionId: SESSION_ID, task: THIRD_STALE },
    );

    await expect(anchor).toContainText(/EQUAL_SEQ_SECOND_NEWER/);
    await expect(anchor).not.toContainText(/EQUAL_SEQ_THIRD_STALE/);
  });
});
