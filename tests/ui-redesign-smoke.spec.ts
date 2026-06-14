import { expect, test, type Page, type Route } from "@playwright/test";

const mockProfile = {
  id: "admin",
  name: "Admin",
  enabled: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  status: { running: true, pid: 1234, uptime_secs: 3600 },
  config: {
    llm: { primary: { family_id: "openai", model_id: "gpt-5.4" }, fallbacks: [] },
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
      docker: { image: "ubuntu:24.04", mount_mode: "read_only", extra_binds: [] },
      read_allow_paths: [],
    },
    plugins: { require_signed: false },
  },
};

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installWorkbenchMocks(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("octos_session_token", "ui-smoke-token");
    localStorage.setItem("octos_auth_token", "ui-smoke-token");
    localStorage.setItem("selected_profile", "admin");
    localStorage.setItem(
      "octos-slides-projects",
      JSON.stringify([
        {
          id: "deck-1",
          title: "Quarterly Brief",
          template: "business",
          tags: ["ai"],
          slides: [{ index: 0, title: "Quarterly Brief", notes: "", layout: "title" }],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
    );
    localStorage.setItem(
      "octos-sites-projects",
      JSON.stringify([
        {
          id: "site-1",
          title: "Signal Atlas",
          preset: "astro",
          template: "astro-site",
          siteKind: "docs",
          slug: "signal-atlas",
          scaffolded: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
    );
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
    if (path === "/api/my/profile") {
      await fulfillJson(route, mockProfile);
      return;
    }
    if (path === "/api/status") {
      await fulfillJson(route, {
        version: "ui-smoke",
        provider: "mock",
        model: "mock-model",
        uptime_secs: 42,
        agent_configured: true,
      });
      return;
    }
    if (path.startsWith("/api/sessions")) {
      await fulfillJson(route, {
        sessions: [{ id: "web-ui-smoke", title: "Visual review", message_count: 0 }],
        current: null,
      });
      return;
    }
    if (path === "/api/admin/platform-skills") {
      await fulfillJson(route, {
        platform_skills: [{ name: "voice", installed: true }],
        skills_dir: "/tmp/skills",
        ominix_api: { url: "http://localhost:8080", healthy: true, service_registered: true },
        models: { dir: "/tmp/models", asr: ["qwen3-asr-1.7b"], tts: ["qwen3-tts"] },
      });
      return;
    }
    if (path.includes("/ominix-api/models")) {
      await fulfillJson(route, { models: [] });
      return;
    }
    await fulfillJson(route, { ok: true });
  });

  await page.routeWebSocket(/\/api\/ui-protocol\/ws/, (ws) => {
    ws.onMessage((raw) => {
      let message: { id?: string; method?: string };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message.id) return;
      const result =
        message.method === "session/list"
          ? { sessions: [{ id: "web-ui-smoke", title: "Visual review", message_count: 0 }] }
          : message.method === "session/messages_page"
            ? { messages: [], has_more: false, next_offset: 0 }
            : message.method === "session/open"
              ? { opened: { session_id: "web-ui-smoke", active_profile_id: "admin" } }
              : message.method === "router/get_metrics"
                ? { mode: "off", provider_count: 1, providers: [] }
                : message.method === "session/status.get"
                  ? { active: false, has_deferred_files: false, has_bg_tasks: false }
                  : message.method === "session/tasks.list"
                    ? { tasks: [] }
                    : message.method === "session/files.list"
                      ? { files: [] }
                      : { ok: true, replayed_envelopes: [] };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe("UI redesign shell smoke", () => {
  test.beforeEach(async ({ page }) => {
    await installWorkbenchMocks(page);
  });

  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`primary workbench routes render without horizontal overflow on ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);

      for (const path of ["/", "/chat", "/settings", "/slides", "/sites"]) {
        await page.goto(path, { waitUntil: "networkidle" });
        await expect(page.locator("#root")).not.toBeEmpty();
        await expectNoHorizontalOverflow(page);
      }
    });
  }

  test("home shell exposes the shared route navigation", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "networkidle" });

    for (const label of [
      "Home",
      "Chat",
      "Slides",
      "Sites",
      "Display",
      "Voice",
      "Settings",
    ]) {
      await expect(
        page.getByRole("link", { name: label, exact: true }),
      ).toBeVisible();
    }
  });

  test("workspace surfaces use the shared topbar titles", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    for (const surface of [
      { path: "/settings", context: "Octos Control", title: "Settings" },
      { path: "/slides", context: "Creation Workspace", title: "Slides" },
      { path: "/sites", context: "Creation Workspace", title: "Site Studio" },
    ]) {
      await page.goto(surface.path, { waitUntil: "networkidle" });
      await expect(page.getByText(surface.context).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: surface.title })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test("settings shell keeps warm restrained control styling", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings", { waitUntil: "networkidle" });

    await expect(page.locator(".settings-shell")).toBeVisible();
    await expect(page.locator(".settings-shell .glass-section").first()).toBeVisible();

    const styling = await page.evaluate(() => {
      const root = document.documentElement;
      const section = document.querySelector(".settings-shell .glass-section");
      const activeTab = document.querySelector(".settings-shell .settings-tab-button[data-active='true']");
      const link = getComputedStyle(root).getPropertyValue("--color-link").trim();
      const sectionRadius = section ? parseFloat(getComputedStyle(section).borderRadius) : Number.NaN;
      const tabRadius = activeTab ? parseFloat(getComputedStyle(activeTab).borderTopRightRadius) : Number.NaN;
      return { link, sectionRadius, tabRadius };
    });

    expect(styling.link.toLowerCase()).not.toMatch(/7ca8b8|4d7f91|blue|purple/);
    expect(styling.sectionRadius).toBeLessThanOrEqual(8);
    expect(styling.tabRadius).toBeLessThanOrEqual(8);
  });
});
