/**
 * B-002 — sse-bridge must pass server_seq/updated_at through the first merge.
 *
 * Before: the sse-bridge's `task_status` handler called `applyTaskStatus`
 * with just `{task}`, dropping any server_seq on the SSE envelope. The
 * runtime-provider listener re-merged with server_seq, but surfaces that
 * read the task-store directly (task anchor bubble) saw the STALE
 * snapshot from the first merge until the listener re-merged.
 *
 * Post-fix: the bridge extracts server_seq / updated_at from envelope
 * (preferred) or the embedded task (fallback) and passes them into the
 * first `applyTaskStatus` call. The runtime-provider listener sees
 * `_alreadyMerged: true` on the re-dispatch and skips its own merge.
 *
 * This test drives a real `/api/chat` SSE stream whose task_status event
 * carries `server_seq: 9` on the envelope and an older in-task
 * `server_seq`. Without the fix, the task-store entry would reflect the
 * in-task seq (first merge dropped the envelope seq) until the runtime-
 * provider listener re-merged on a subsequent microtask. With the fix,
 * the FIRST merge writes seq=9 immediately.
 *
 * We also pre-seed a stale snapshot at seq=1 and require that the SSE
 * task_status event wins on its first merge even when the
 * runtime-provider listener is told to skip (`_alreadyMerged: true`).
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-sse-bridge-server-seq";
const TASK_ID = "task-sse-server-seq-001";
const OLDER_TASK = {
  id: TASK_ID,
  tool_name: "Deep research",
  tool_call_id: "call-sse-seq-001",
  status: "running" as const,
  started_at: "2026-04-20T12:00:00Z",
  completed_at: null,
  output_files: [],
  error: null,
  session_key: `api:${SESSION_ID}`,
  current_phase: "research",
  progress_message: "STALE",
  progress: 0.1,
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
      body: "",
    });
  });
}

test.describe("B-002 — sse-bridge passes server_seq to the first merge", () => {
  test("envelope server_seq wins on the first merge (without listener re-merge)", async ({
    page,
  }) => {
    await installMockRuntime(page);
    // /api/chat returns a single task_status event with envelope
    // server_seq=9 and a done. The in-task server_seq is intentionally
    // lower (or absent) so the test proves the envelope seq got
    // extracted into the first applyTaskStatus call.
    await page.route(/\/api\/chat(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sse([
          {
            type: "task_status",
            task: {
              ...OLDER_TASK,
              current_phase: "synthesize",
              progress_message: "FRESH",
              progress: 0.9,
            },
            // NOTE: envelope seq — NOT on the task. This is the
            // pre-fix drop case.
            server_seq: 9,
            updated_at: "2026-04-20T12:05:00Z",
          },
          { type: "done", content: "ok" },
        ]),
      });
    });
    await page.addInitScript((sessionId) => {
      localStorage.clear();
      localStorage.setItem("octos_session_token", "mock-token");
      localStorage.setItem("octos_auth_token", "mock-token");
      localStorage.setItem("selected_profile", "dspfac");
      localStorage.setItem("octos_current_session", sessionId);
    }, SESSION_ID);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    // Pre-seed: stale task at seq=1 via crew:task_status dispatch (which
    // goes through the runtime-provider listener → applyTaskStatus).
    await page.evaluate(
      ({ sessionId, task }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: {
              sessionId,
              task,
              server_seq: 1,
              updated_at: "2026-04-20T12:00:01Z",
            },
          }),
        );
      },
      { sessionId: SESSION_ID, task: OLDER_TASK },
    );
    const anchor = page.locator(`[data-testid="task-anchor-message-${TASK_ID}"]`);
    await expect(anchor).toBeVisible({ timeout: 10_000 });
    await expect(anchor).toContainText(/STALE/);

    // Capture the re-dispatched event on window so we can assert
    // `_alreadyMerged: true` is set on the bridge's re-dispatch.
    await page.evaluate(() => {
      (window as unknown as { __captured__?: unknown[] }).__captured__ = [];
      window.addEventListener("crew:task_status", (e) => {
        (window as unknown as { __captured__: Array<Record<string, unknown>> })
          .__captured__.push((e as CustomEvent).detail);
      });
    });

    // Send a message — the mocked /api/chat returns the task_status SSE
    // with envelope seq=9. The SSE bridge must extract it and perform
    // the first merge with serverSeq=9.
    await page.fill(SEL.chatInput, "kick the bridge");
    await page.click(SEL.sendButton);

    // The task anchor updates to the FRESH phase because the first merge
    // carried envelope seq=9 > stored seq=1.
    await expect(anchor).toContainText(/FRESH/, { timeout: 10_000 });
    await expect(anchor).not.toContainText(/STALE/);

    // And the bridge's re-dispatch must mark `_alreadyMerged: true`.
    const captured = await page.evaluate(
      () =>
        (window as unknown as { __captured__: Array<Record<string, unknown>> })
          .__captured__,
    );
    const bridgeDispatch = captured.find(
      (d) => d._alreadyMerged === true,
    );
    expect(bridgeDispatch).toBeTruthy();
    expect(bridgeDispatch?.serverSeq).toBe(9);
    expect(bridgeDispatch?.updatedAt).toBe("2026-04-20T12:05:00Z");
  });
});
