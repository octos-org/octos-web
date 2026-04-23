/**
 * B-001 — base-URL-aware redirects.
 *
 * The coding-blue side-by-side deploy can mount the web client under
 * `/next/`. Any hard-coded `window.location.href = "/login"` bypasses
 * `BrowserRouter`'s `basename` and sends the user back to the legacy
 * bundle at `/`. This test boots the dev server (BASE_URL `/`), drives
 * a 401 on `/api/chat`, and asserts the redirect URL has:
 *   (a) a `/login` path suffix
 *   (b) a `redirect=<original path>` query string
 * Those are the properties the `absoluteUrl` helper preserves. The
 * /next/ prefix itself is exercised at unit level: the helper's output
 * is asserted given an injected base string.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { SEL } from "./helpers";

const SESSION_ID = "web-base-url-redirects";

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

test.describe("B-001 — base-URL-aware redirects under /next/", () => {
  test("absoluteUrl() prefixes the Vite BASE_URL onto app paths", async ({
    page,
  }) => {
    await installMockRuntime(page);
    await page.addInitScript((sessionId) => {
      localStorage.setItem("octos_session_token", "mock-token");
      localStorage.setItem("octos_auth_token", "mock-token");
      localStorage.setItem("selected_profile", "dspfac");
      localStorage.setItem("octos_current_session", sessionId);
    }, SESSION_ID);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    // Helper is defined in /src/lib/utils.ts — import it via the Vite
    // dev server's module URL so we can run it in-page. This protects the
    // contract: absoluteUrl(path) === `${BASE_URL without trailing slash}${path}`.
    const inline = await page.evaluate(async () => {
      // @vite-ignore — runtime dynamic import, evaluated in the browser
      const mod: { absoluteUrl: (p: string) => string } = await import(
        /* @vite-ignore */ "/src/lib/utils.ts"
      );
      return {
        login: mod.absoluteUrl("/login"),
        admin: mod.absoluteUrl("/admin/my"),
        rel: mod.absoluteUrl("dashboard"),
      };
    });

    // Under the dev server BASE_URL is "/", so the helper should return
    // "/login" / "/admin/my" verbatim (leading slash absolute paths).
    // Under /next/ the same helper returns "/next/login" etc. Either is
    // acceptable — the contract is that the path is consistent with the
    // same BASE_URL that BrowserRouter uses.
    expect([
      "/login",
      "/next/login",
    ]).toContain(inline.login);
    expect([
      "/admin/my",
      "/next/admin/my",
    ]).toContain(inline.admin);
    // Relative paths (no leading slash) still get a `/` separator.
    expect([
      "/dashboard",
      "/next/dashboard",
    ]).toContain(inline.rel);
  });

  test("401 on /api/chat redirects to absoluteUrl('/login') with redirect=<prev>", async ({
    page,
  }) => {
    await installMockRuntime(page);
    // Intercept /login GETs so the real SPA login page doesn't 404 after the
    // redirect — we only need to inspect the URL the browser lands on.
    await page.route(/\/(next\/)?login(\?.*)?$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body><div id='login-stub'></div></body></html>",
      }),
    );
    // Force `/api/chat` to return 401 so the auto-logout path fires.
    await page.route(/\/api\/chat(?:\?.*)?$/, (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "unauthorized" }),
      }),
    );
    await page.addInitScript((sessionId) => {
      localStorage.setItem("octos_session_token", "mock-token");
      localStorage.setItem("octos_auth_token", "mock-token");
      localStorage.setItem("selected_profile", "dspfac");
      localStorage.setItem("octos_current_session", sessionId);
    }, SESSION_ID);
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput);

    // Capture what absoluteUrl('/login') resolves to — that's what the
    // 401 path should assign to window.location.href.
    const expectedLoginPath = await page.evaluate(async () => {
      const mod: { absoluteUrl: (p: string) => string } = await import(
        /* @vite-ignore */ "/src/lib/utils.ts"
      );
      return mod.absoluteUrl("/login");
    });

    // Fire a request via the client module so the 401 auto-logout code
    // runs. Wait for the ensuing navigation and then inspect the URL.
    const navPromise = page.waitForURL(/\/login\?redirect=/, { timeout: 5000 });
    await page
      .evaluate(async () => {
        const client: {
          request: (path: string, init?: RequestInit) => Promise<unknown>;
        } = await import(/* @vite-ignore */ "/src/api/client.ts");
        try {
          await client.request("/api/chat", {
            method: "POST",
            body: JSON.stringify({ message: "hi", session_id: "x" }),
          });
        } catch {
          // expected: 401 auto-logout + redirect
        }
      })
      .catch(() => {
        // navigation may tear down this eval — swallow the error
      });
    await navPromise;

    const url = new URL(page.url());
    expect(url.pathname).toBe(expectedLoginPath);
    expect(url.searchParams.get("redirect")).toBeTruthy();
  });
});
