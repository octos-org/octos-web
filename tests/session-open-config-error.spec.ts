/**
 * E2E regression for #351: a typed terminal configuration failure from
 * `session/open` (real-shaped `data_dir_locked` RPC error — the verbatim
 * sentence shape of `data_dir_locked_error` in
 * octos-cli/src/api/ui_protocol_transport.rs) must surface the server's
 * diagnosis on the send ghost immediately, keep the existing login, and
 * recover through the explicit Retry button once the conflict is resolved —
 * instead of burning the reconnect budget and ending at the generic
 * "Unable to establish the UI Protocol connection" message.
 *
 * Mocked backend (page.route + routeWebSocket), same style as
 * tests/ui-redesign-smoke.spec.ts: only the octos-core server process is
 * scripted; the browser runs the real bridge → runtime → send → Chat stack.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

const SESSION_ID = "web-config-lock";

// Verbatim sentence of the server's `data_dir_locked_error` (the
// `Details:` tail renders the raw server-side error chain — representative
// redb text here, everything before it is byte-identical). The bridge must
// render `data.message` (identical to `error.message` here) as-is.
const LOCKED_SENTENCE =
  "Can't start a session for profile 'admin' — another octos process " +
  "already owns this profile's data directory, and its storage allows " +
  "only one writer. Stop the other `octos serve` (if it is supervised, " +
  "e.g. by launchd, stop the service rather than the process — it " +
  "will be restarted otherwise), or give this instance its own " +
  "storage with `--instance-data-dir <dir>`. Details: redb error: " +
  "Database is already open by another process " +
  "(path: /var/lib/octos/admin/episodes.redb)";

const USER_TEXT = "hello after the lock is gone";

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** Scripted octos-core. `lock.held` models the deployment conflict: while
 *  held, every `session/open` fails with the typed terminal error; once
 *  released, opens succeed and turns complete through the canonical v2
 *  projection stream. */
async function installMockBackend(
  page: Page,
  lock: { held: boolean },
): Promise<{ openRequests: string[] }> {
  const openRequests: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem("octos_session_token", "spec-token");
    localStorage.setItem("octos_auth_token", "spec-token");
    localStorage.setItem("selected_profile", "admin");
  });

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/status") {
      await fulfillJson(route, {
        bootstrap_mode: false,
        email_login_enabled: true,
        admin_token_login_enabled: true,
        allow_self_registration: false,
      });
      return;
    }
    if (path === "/api/auth/me") {
      await fulfillJson(route, {
        user: {
          id: "admin",
          email: "admin@localhost",
          name: "Admin",
          role: "admin",
          created_at: "2026-01-01T00:00:00Z",
          last_login_at: null,
        },
        profile: { profile: { id: "admin", name: "Admin" } },
        portal: {
          kind: "admin",
          home_profile_id: "admin",
          home_route: "/",
          can_access_admin_portal: true,
          can_manage_users: true,
          sub_account_limit: 10,
          accessible_profiles: [],
        },
      });
      return;
    }
    if (path === "/api/status") {
      await fulfillJson(route, {
        version: "config-lock-spec",
        provider: "mock",
        model: "mock-model",
        uptime_secs: 42,
        agent_configured: true,
      });
      return;
    }
    if (path === "/api/my/profile") {
      // A configured LLM keeps the Chat header out of its "no model set
      // up" notice — unrelated to this spec's failure mode.
      await fulfillJson(route, {
        id: "admin",
        name: "Admin",
        enabled: true,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        status: { running: true, pid: 1, uptime_secs: 60 },
        config: {
          llm: { primary: { family_id: "mock", model_id: "mock-1" }, fallbacks: [] },
          channels: [],
          gateway: {},
          env_vars: {},
          hooks: [],
          email: "admin@localhost",
          admin_mode: true,
          sandbox: {
            enabled: false,
            mode: "off",
            allow_network: false,
            docker: {
              image: "ubuntu:24.04",
              mount_mode: "read_only",
              extra_binds: [],
            },
            read_allow_paths: [],
          },
          plugins: { require_signed: false },
        },
      });
      return;
    }
    if (path.startsWith("/api/sessions")) {
      await fulfillJson(route, {
        sessions: [
          {
            id: SESSION_ID,
            title: "Config lock",
            message_count: 0,
          },
        ],
        current: null,
      });
      return;
    }
    await fulfillJson(route, { ok: true });
  });

  await page.routeWebSocket(/\/api\/ui-protocol\/ws/, (ws) => {
    // The Chat surface mints its own `web-<ts>-<rand>` session id on /chat;
    // every reply below must echo THAT id or the bridge silently drops the
    // frames as cross-session.
    let liveSessionId = SESSION_ID;
    ws.onMessage((raw) => {
      let message: {
        id?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message.id) return;
      const params = message.params ?? {};
      if (message.method === "session/open") {
        liveSessionId = String(params.session_id ?? SESSION_ID);
        openRequests.push(liveSessionId);
        if (lock.held) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32603,
                message: LOCKED_SENTENCE,
                data: {
                  kind: "data_dir_locked",
                  profile_id: "admin",
                  message: LOCKED_SENTENCE,
                },
              },
            }),
          );
          return;
        }
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              opened: {
                session_id: liveSessionId,
                active_profile_id: "admin",
                capabilities: {
                  supported_features: ["projection.envelope.v2"],
                },
              },
            },
          }),
        );
        return;
      }
      if (message.method === "turn/start") {
        const turnId = String(params.turn_id ?? "turn-1");
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { accepted: true, turn_id: turnId },
          }),
        );
        // Canonical v2 projection stream for the accepted turn: user row
        // (carrying the client_message_id so the ghost settles), assistant
        // reply, then the completed terminal.
        const base = {
          session_id: liveSessionId,
          thread_id: "thread-1",
          turn_id: turnId,
        };
        const envelopes = [
          {
            ...base,
            seq: 1,
            client_message_id: turnId,
            cursor: { stream: liveSessionId, seq: 1 },
            payload: {
              type: "user_message",
              data: { text: USER_TEXT, files: [] },
            },
          },
          {
            ...base,
            seq: 2,
            cursor: { stream: liveSessionId, seq: 2 },
            payload: {
              type: "assistant_persisted",
              data: {
                text: "Conflict resolved — the chat is working again.",
                assistant_segment_id: `${turnId}-seg-1`,
                meta: {
                  message_id: `${turnId}-msg-1`,
                  persisted_at: new Date().toISOString(),
                },
              },
            },
          },
          {
            ...base,
            seq: 3,
            cursor: { stream: liveSessionId, seq: 3 },
            payload: { type: "turn_terminal", data: { outcome: "completed" } },
          },
        ];
        for (const envelope of envelopes) {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "projection/envelope",
              params: envelope,
            }),
          );
        }
        return;
      }
      if (message.method === "session/hydrate") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              session_id: liveSessionId,
              cursor: { stream: liveSessionId, seq: 0 },
              messages: [],
            },
          }),
        );
        return;
      }
      if (message.method === "session/status.get") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { active: false, has_deferred_files: false, has_bg_tasks: false },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { ok: true, replayed_envelopes: [] },
        }),
      );
    });
  });

  return { openRequests };
}

test.describe("session/open typed configuration failures (#351)", () => {
  test("server diagnosis surfaces immediately, login is retained, Retry recovers", async ({
    page,
  }) => {
    const lock = { held: true };
    const { openRequests } = await installMockBackend(page, lock);

    await page.goto(`/chat?session=${SESSION_ID}`, { waitUntil: "domcontentloaded" });
    const input = page.locator("[data-testid='chat-input']");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(USER_TEXT);
    await page.keyboard.press("Enter");

    // The diagnosis must appear on the ghost row — the server's own
    // sentence, not the generic transport message. It is terminal and
    // immediate, well ahead of the 10s startup deadline the pre-fix
    // behavior burned before showing the wrong remedy.
    const errorRow = page.locator("[data-testid='ghost-bubble-error']");
    await expect(errorRow).toBeVisible({ timeout: 5_000 });
    await expect(errorRow).toContainText(
      "another octos process already owns this profile's data directory",
    );
    await expect(errorRow).toContainText("--instance-data-dir");
    await expect(errorRow).not.toContainText("Unable to establish");

    // Login is retained: no redirect off /chat, credentials untouched.
    await expect(page).toHaveURL(new RegExp(`/chat`));
    expect(
      await page.evaluate(() => localStorage.getItem("octos_auth_token")),
    ).toBe("spec-token");

    // Exactly one session/open per explicit Retry — the bridge must not
    // be silently reconnecting behind the failed UI attempt.
    const attemptsBeforeRetry = openRequests.length;
    expect(attemptsBeforeRetry).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1_500);
    expect(openRequests.length).toBe(attemptsBeforeRetry);

    // Operator resolves the conflict (stops the other process), then the
    // user clicks the explicit Retry: the turn now completes end-to-end.
    lock.held = false;
    await page.locator("[data-testid='ghost-bubble-retry']").click();

    await expect(
      page.getByText("Conflict resolved — the chat is working again."),
    ).toBeVisible({ timeout: 15_000 });
    // The failed ghost overlay is gone (settled + terminal removed it).
    await expect(page.locator("[data-testid='ghost-bubble']")).toHaveCount(0, {
      timeout: 5_000,
    });
    expect(openRequests.length).toBe(attemptsBeforeRetry + 1);
  });
});
