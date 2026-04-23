/**
 * B-007 — task-store must not persist under the `unknown` profile.
 *
 * Before: module-level `activeProfile` fell back to `"unknown"` when no
 * `selected_profile` key was in localStorage. Any task-store write in
 * that window produced an `octos_web:task_store:v1:unknown:...` entry.
 * On subsequent login, another user on the same device inherited that
 * entry via the store's `unknown`-keyed rehydrate — a cross-account
 * bleed.
 *
 * Post-fix:
 *   (1) A profile of `""`, `"unknown"`, or falsy → skip persistence
 *       (both read and write paths). In-memory state still works but
 *       localStorage never sees an `unknown:` prefix.
 *   (2) When a real profile id replaces an unknown one via
 *       `rehydrateTaskStore`, any lingering `unknown:` entries are
 *       purged.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-unknown-profile";
const TASK_ID = "task-unknown-profile-001";

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

test.describe("B-007 — task-store skips persistence under unknown profile", () => {
  test("no octos_web:task_store:v1:unknown:* keys are written when profile is unknown", async ({
    page,
  }) => {
    await installMockRuntime(page);
    // Mount WITHOUT `selected_profile` in localStorage so the module-level
    // activeProfile defaults to "unknown".
    await page.addInitScript((sessionId) => {
      localStorage.clear();
      // Intentionally do NOT set selected_profile.
      localStorage.setItem("octos_session_token", "mock-token");
      localStorage.setItem("octos_auth_token", "mock-token");
      localStorage.setItem("octos_current_session", sessionId);
    }, SESSION_ID);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    // Dispatch a task_status so the store writes. Pre-fix, this triggered
    // a debounced persistence flush that wrote to `unknown:<session>`.
    await page.evaluate(
      ({ sessionId, taskId }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: {
              sessionId,
              task: {
                id: taskId,
                tool_name: "Deep research",
                tool_call_id: "call-unknown-001",
                status: "running",
                started_at: "2026-04-20T12:00:00Z",
                completed_at: null,
                output_files: [],
                error: null,
                session_key: `api:${sessionId}`,
                current_phase: "research",
                progress_message: "making progress",
                progress: 0.1,
              },
              server_seq: 1,
              updated_at: "2026-04-20T12:00:01Z",
            },
          }),
        );
      },
      { sessionId: SESSION_ID, taskId: TASK_ID },
    );
    // Bubble should still render from in-memory state.
    await expect(
      page.locator(`[data-testid="task-anchor-message-${TASK_ID}"]`),
    ).toBeVisible({ timeout: 10_000 });

    // Wait longer than the debounce window (250 ms) to guarantee any
    // would-be persist fire has elapsed.
    await page.waitForTimeout(500);

    // Force a synchronous flush so the test isn't just racing the timer.
    await page.evaluate(async () => {
      const ts: {
        __flushTaskStorePersistenceForTests: () => void;
      } = await import(/* @vite-ignore */ "/src/store/task-store");
      ts.__flushTaskStorePersistenceForTests();
    });

    const unknownKeys = await page.evaluate(() => {
      const hits: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("octos_web:task_store:v1:unknown:")) {
          hits.push(key);
        }
      }
      return hits;
    });
    expect(unknownKeys).toEqual([]);
  });

  test("transitioning from unknown → real profile clears any unknown: entries", async ({
    page,
  }) => {
    await installMockRuntime(page);
    // Override /api/auth/me so no profile is auto-set on mount — we want
    // `selected_profile` to remain unset until the explicit transition
    // below. This simulates an anonymous or pre-login state where
    // something wrote an `unknown:` entry that must be purged on login.
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
        // Profile intentionally absent — mimics the pre-login window
        // where activeProfile defaults to "unknown".
        profile: null,
        portal: null,
      }),
    );
    // Pre-seed an octos_web:task_store:v1:unknown:<session> entry so we
    // can verify the transition clears it. The fix must remove it when
    // the store rehydrates under a real profile.
    await page.addInitScript((sessionId) => {
      localStorage.clear();
      localStorage.setItem("octos_session_token", "mock-token");
      localStorage.setItem("octos_auth_token", "mock-token");
      localStorage.setItem("octos_current_session", sessionId);
      localStorage.setItem(
        `octos_web:task_store:v1:unknown:${sessionId}`,
        JSON.stringify({
          scoped: {
            [sessionId]: [
              {
                id: "leftover-task",
                tool_name: "x",
                tool_call_id: "c1",
                status: "running",
                started_at: "2026-04-20T12:00:00Z",
                completed_at: null,
                output_files: [],
                error: null,
                server_seq: 1,
              },
            ],
          },
        }),
      );
    }, SESSION_ID);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    // At this point the app is running with unknown profile. Confirm the
    // leftover entry is still on disk.
    const beforeKey = await page.evaluate(
      (sessionId) =>
        localStorage.getItem(`octos_web:task_store:v1:unknown:${sessionId}`),
      SESSION_ID,
    );
    expect(beforeKey).not.toBeNull();

    // Simulate login: import the task-store module BEFORE setting the
    // `selected_profile` key so the module-init reads "unknown" (the
    // starting state). Then call rehydrateTaskStore with the real
    // profile, which triggers the unknown → real transition cleanup.
    await page.evaluate(
      async ({ sessionId }) => {
        const ts: {
          rehydrateTaskStore: (opts: {
            profile: string;
            session: string;
          }) => void;
        } = await import(/* @vite-ignore */ "/src/store/task-store");
        // Now flip localStorage and rehydrate under the real profile.
        localStorage.setItem("selected_profile", "dspfac");
        ts.rehydrateTaskStore({ profile: "dspfac", session: sessionId });
      },
      { sessionId: SESSION_ID },
    );

    // The unknown: entry must be purged.
    const afterKey = await page.evaluate(
      (sessionId) =>
        localStorage.getItem(`octos_web:task_store:v1:unknown:${sessionId}`),
      SESSION_ID,
    );
    expect(afterKey).toBeNull();
  });
});
