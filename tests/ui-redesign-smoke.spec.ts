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

const mockSmartHomeDevices = [
  {
    id: "real_tv",
    name: "Living Room TV",
    home: "Main home",
    room: "Living room",
    kind: "tv",
    on: true,
    online: true,
    readonly: true,
    volume: 24,
    brightness: 24,
    mode: "HDMI 1",
    note: "Input HDMI 1",
    color: "#60a5fa",
  },
  {
    id: "real_ac",
    name: "Bedroom AC",
    home: "Main home",
    room: "Bedroom",
    kind: "climate",
    on: true,
    online: true,
    readonly: false,
    temperature: 24,
    brightness: 24,
    mode: "cool",
    note: "Target 24C",
    color: "#38bdf8",
  },
  {
    id: "curtain",
    name: "Kitchen Curtain",
    home: "Main home",
    room: "Kitchen",
    kind: "cover",
    on: true,
    online: true,
    readonly: false,
    position: 66,
    brightness: 66,
    mode: "open",
    note: "Position 66%",
    color: "#22c55e",
  },
  {
    id: "camera_wangwang",
    name: "Wangwang Camera",
    home: "Camera home",
    room: "Living room",
    kind: "camera",
    on: true,
    online: true,
    readonly: true,
    stream: "available",
    stream_capable: true,
    stream_protocol: "rtc",
    mode: "ready",
    note: "Stream available",
    color: "#64748b",
  },
];

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

type UiSmokeMessage = {
  seq: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  client_message_id?: string;
  thread_id?: string;
  response_to_client_message_id?: string;
  message_id?: string;
  source?: string;
};

async function installWorkbenchMocks(
  page: Page,
  options: { messages?: UiSmokeMessage[] } = {},
) {
  const messages = options.messages ?? [];
  const contentEntry = {
    id: "content-1",
    filename: "family-plan.md",
    path: "pf/mock/family-plan.md",
    category: "report",
    size_bytes: 128,
    created_at: "2026-01-01T00:00:00Z",
    thumbnail_path: null,
    session_id: "web-ui-smoke",
    tool_name: "write_file",
    caption: "Shared household notes",
  };
  const sessionFile = {
    filename: contentEntry.filename,
    path: contentEntry.path,
    size_bytes: contentEntry.size_bytes,
    modified_at: contentEntry.created_at,
  };

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
    if (path === "/api/my/content") {
      await fulfillJson(route, { entries: [contentEntry], total: 1 });
      return;
    }
    if (path === "/api/files/list") {
      await fulfillJson(route, [
        {
          filename: contentEntry.filename,
          path: contentEntry.path,
          size: contentEntry.size_bytes,
          modified: contentEntry.created_at,
          category: "report",
          group: "Shared household notes",
        },
      ]);
      return;
    }
    if (path.startsWith("/api/sessions")) {
      await fulfillJson(route, {
      sessions: [{ id: "web-ui-smoke", title: "Visual review", message_count: messages.length }],
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
    if (path === "/api/integrations/bilibili/first-video") {
      await fulfillJson(route, {
        title: "40分钟做饭神曲合集",
        url: "https://www.bilibili.com/video/BV1cTcbzNE9p/",
      });
      return;
    }
    if (path.includes("/ominix-api/models")) {
      await fulfillJson(route, { models: [] });
      return;
    }
    await fulfillJson(route, { ok: true });
  });

  await page.route((url) => url.pathname.startsWith("/smart-home-api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/smart-home-api/health") {
      await fulfillJson(route, {
        ok: true,
        devices: mockSmartHomeDevices.length,
        home_assistant: "connected",
      });
      return;
    }
    if (path === "/smart-home-api/devices") {
      await fulfillJson(route, {
        source: "home_assistant",
        devices: mockSmartHomeDevices,
      });
      return;
    }
    if (path.startsWith("/smart-home-api/devices/")) {
      await fulfillJson(route, { ok: true, source: "home_assistant" });
      return;
    }
    if (path.startsWith("/smart-home-api/cameras/")) {
      await fulfillJson(route, {
        ok: true,
        protocol: "rtc",
        playback_url: "http://127.0.0.1:1984/stream.html?src=wangwang",
      });
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
          ? { sessions: [{ id: "web-ui-smoke", title: "Visual review", message_count: messages.length }] }
          : message.method === "session/messages_page"
            ? { messages, has_more: false, next_offset: messages.length }
            : message.method === "session/open"
              ? { opened: { session_id: "web-ui-smoke", active_profile_id: "admin" } }
              : message.method === "router/get_metrics"
                ? { mode: "off", provider_count: 1, providers: [] }
                : message.method === "session/status.get"
                  ? { active: false, has_deferred_files: false, has_bg_tasks: false }
                  : message.method === "session/tasks.list"
                    ? { tasks: [] }
                    : message.method === "session/files.list"
                      ? { files: [sessionFile] }
                      : message.method === "content/list"
                        ? { entries: [contentEntry], total: 1 }
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

  test("home status tiles navigate instead of looking inert", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/", { waitUntil: "networkidle" });

    await page.getByTestId("home-status-tile").filter({ hasText: "Local decks" }).click();
    await expect(page).toHaveURL(/\/slides$/);

    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("home-status-tile").filter({ hasText: "Display mode" }).click();
    await expect(page).toHaveURL(/\/home$/);
  });

  test("mobile home navigation keeps visible controls inside the viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });

    const offscreenControls = await page.evaluate(() => {
      const controls = Array.from(
        document.querySelectorAll(".workbench-topbar a, .workbench-topbar button"),
      );
      return controls
        .map((control) => {
          const rect = control.getBoundingClientRect();
          const text =
            (control.textContent ||
              control.getAttribute("aria-label") ||
              control.getAttribute("title") ||
              "").trim();
          return {
            text,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          };
        })
        .filter(
          (control) =>
            control.width > 0 &&
            (control.left < -1 || control.right > window.innerWidth + 1),
        );
    });

    expect(offscreenControls).toEqual([]);
  });

  test("workbench topbar route icons are readable and not edge-clipped", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 728, height: 694 });
    await page.goto("/", { waitUntil: "networkidle" });

    const geometry = await page.evaluate(() => {
      const nav = document.querySelector(".workbench-route-nav");
      const firstLink = document.querySelector(".workbench-route-link");
      const firstIcon = firstLink?.querySelector("svg");
      const brandIcon = document.querySelector(".workbench-brand img");
      const navStyle = nav ? getComputedStyle(nav) : null;
      const firstIconRect = firstIcon?.getBoundingClientRect();
      const brandIconRect = brandIcon?.getBoundingClientRect();
      return {
        maskImage: navStyle?.maskImage ?? "",
        webkitMaskImage: navStyle?.webkitMaskImage ?? "",
        routeIconWidth: firstIconRect?.width ?? 0,
        routeIconLeft: firstIconRect?.left ?? 0,
        navLeft: nav?.getBoundingClientRect().left ?? 0,
        brandIconWidth: brandIconRect?.width ?? 0,
        brandIconHeight: brandIconRect?.height ?? 0,
      };
    });

    expect(geometry.maskImage).toBe("none");
    expect(geometry.webkitMaskImage).toBe("none");
    expect(geometry.routeIconWidth).toBeGreaterThanOrEqual(18);
    expect(geometry.routeIconLeft).toBeGreaterThanOrEqual(geometry.navLeft);
    expect(geometry.brandIconWidth).toBeGreaterThanOrEqual(24);
    expect(geometry.brandIconHeight).toBeGreaterThanOrEqual(24);
  });

  test("home settings drawer hides closed controls from visual audits", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/home", { waitUntil: "networkidle" });

    const panel = page.locator(".home-settings-panel");
    await expect(panel).toHaveCSS("visibility", "hidden");

    await page.locator(".home-settings-gear").click();
    await expect(panel).toHaveCSS("visibility", "visible");
    const burnInField = page
      .locator(".home-settings-panel .space-y-2")
      .filter({ hasText: "Burn-in Protection" });
    await expect(burnInField).toBeVisible();
    await burnInField.getByRole("button", { name: "On" }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("octos_home_burn_in_protection")))
      .toBe("true");

    await page.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCSS("visibility", "hidden");
  });

  test("home blank space does not enter conversation mode", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/home", { waitUntil: "networkidle" });

    const readMode = () =>
      page.evaluate(() => {
        const layers = Array.from(document.querySelectorAll(".home-layer"));
        return layers.map((layer) => {
          const style = getComputedStyle(layer);
          return {
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
          };
        });
      });

    expect(await readMode()).toEqual([
      { opacity: "1", pointerEvents: "auto" },
      { opacity: "0", pointerEvents: "none" },
    ]);

    await page.mouse.click(1320, 820);
    await page.waitForTimeout(100);
    expect(await readMode()).toEqual([
      { opacity: "1", pointerEvents: "auto" },
      { opacity: "0", pointerEvents: "none" },
    ]);

    await page.getByRole("button", { name: "Chat" }).click();
    await expect.poll(readMode).toEqual([
      { opacity: "0", pointerEvents: "none" },
      { opacity: "1", pointerEvents: "auto" },
    ]);
  });

  test("home settings can switch back to the classic dashboard UI", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/home", { waitUntil: "networkidle" });

    await expect(page.locator(".metro-grid")).toBeVisible();

    await page.locator(".home-settings-gear").click();
    await page.getByRole("button", { name: "Grid" }).click();
    await expect(page.locator(".classic-home-standby")).toBeVisible();
    await expect(page.locator(".metro-grid")).toHaveCount(0);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator(".classic-home-standby")).toBeVisible();
    await expect(page.locator(".metro-grid")).toHaveCount(0);

    await page.locator(".home-settings-gear").click();
    await page.getByRole("button", { name: "Metro" }).click();
    await expect(page.locator(".metro-grid")).toBeVisible();
  });

  test("home smart home widget renders bridge devices", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/home", { waitUntil: "networkidle" });

    const panel = page.getByTestId("smart-home-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Smart Home");
    await expect(panel).toContainText("Living Room TV");
    await expect(panel).toContainText("Kitchen Curtain");
    await expect(panel).toContainText("4");
    await expect(panel.getByRole("button", { name: "Refresh" })).toBeVisible();

    const overflow = await page.evaluate(() => {
      const panelEl = document.querySelector('[data-testid="smart-home-panel"]');
      const rect = panelEl?.getBoundingClientRect();
      return {
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        panelRight: rect?.right ?? 0,
        viewportWidth: window.innerWidth,
      };
    });

    expect(overflow.documentOverflow).toBeLessThanOrEqual(1);
    expect(overflow.panelRight).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  });

  test("home smart home device rows open device-specific controls", async ({ page }) => {
    await page.setViewportSize({ width: 948, height: 749 });
    await page.goto("/home", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: "Living Room TV controls" }).click();
    const panel = page.getByRole("dialog", { name: "Living Room TV controls" });
    await expect(panel).toBeVisible();
    const panelBox = await page.locator(".smart-home-device-popover").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.y).toBeGreaterThanOrEqual(8);
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(749 - 8);
    await expect(panel).toContainText("HDMI 1");
    await expect(panel.getByRole("button", { name: "Living Room TV Vol +" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Living Room TV Home" })).toBeVisible();
    const tvVolumeAction = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        request.method() === "POST" &&
        url.pathname === "/smart-home-api/devices/real_tv" &&
        request.postData()?.includes("action=volume_up") === true
      );
    });
    await panel.getByRole("button", { name: "Living Room TV Vol +" }).click();
    await tvVolumeAction;

    await panel.getByRole("button", { name: "Living Room TV close controls" }).click();
    await page.getByRole("button", { name: "Bedroom AC controls" }).click();
    const climatePanel = page.getByRole("dialog", { name: "Bedroom AC controls" });
    await expect(climatePanel).toBeVisible();
    await expect(climatePanel.getByLabel("Bedroom AC Fan")).toBeVisible();
    await expect(climatePanel.getByRole("button", { name: "Cool", exact: true })).toBeVisible();
  });

  test("classic home uses an aligned widget grid", async ({ page }) => {
    await page.setViewportSize({ width: 859, height: 819 });
    await page.addInitScript(() => {
      localStorage.setItem("octos_home_ui_style", "classic");
      localStorage.setItem("octos_home_night_mode", "off");
      localStorage.setItem("octos_home_city", "Tokyo");
    });

    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".classic-home-grid")).toBeVisible();

    const layout = await page.evaluate(() => {
      const grid = document.querySelector(".classic-home-grid");
      if (!grid) return { display: "", columns: 0, maxSameRow: 0 };
      const style = getComputedStyle(grid);
      const children = Array.from(grid.children)
        .map((child) => child.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const rowCounts = new Map<number, number>();
      for (const rect of children) {
        const top = Math.round(rect.top / 4) * 4;
        rowCounts.set(top, (rowCounts.get(top) ?? 0) + 1);
      }
      return {
        display: style.display,
        columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
        maxSameRow: Math.max(0, ...rowCounts.values()),
      };
    });

    expect(layout.display).toBe("grid");
    expect(layout.columns).toBeGreaterThanOrEqual(4);
    expect(layout.maxSameRow).toBeGreaterThanOrEqual(2);
  });

  test("classic home weather content stays inside its tile", async ({ page }) => {
    await page.setViewportSize({ width: 859, height: 819 });
    await page.addInitScript(() => {
      localStorage.setItem("octos_home_ui_style", "classic");
      localStorage.setItem("octos_home_night_mode", "off");
      localStorage.setItem("octos_home_city", "Tokyo");
    });
    await page.route("https://geocoding-api.open-meteo.com/**", async (route) => {
      await fulfillJson(route, {
        results: [{ latitude: 35.6762, longitude: 139.6503 }],
      });
    });
    await page.route("https://api.open-meteo.com/**", async (route) => {
      await fulfillJson(route, {
        current: { temperature_2m: 17, weather_code: 1 },
        hourly: {
          time: [
            "2026-06-15T23:00",
            "2026-06-16T00:00",
            "2026-06-16T01:00",
            "2026-06-16T02:00",
            "2026-06-16T03:00",
          ],
          temperature_2m: [17, 17, 17, 17, 16],
          weather_code: [1, 1, 1, 1, 0],
        },
      });
    });

    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".classic-home-weather-panel")).toContainText("Tokyo");

    const overflow = await page.evaluate(() => {
      const tile = document.querySelector(".classic-home-weather-panel");
      const content = tile?.querySelector(".home-weather-layout");
      const tileRect = tile?.getBoundingClientRect();
      const contentRect = content?.getBoundingClientRect();
      return {
        tileRight: tileRect?.right ?? 0,
        contentRight: contentRect?.right ?? 0,
        scrollOverflow: tile ? tile.scrollWidth - tile.clientWidth : 0,
      };
    });

    expect(overflow.contentRight).toBeLessThanOrEqual(overflow.tileRight + 1);
    expect(overflow.scrollOverflow).toBeLessThanOrEqual(1);
  });

  test("home music tile toggles hidden Bilibili sound without leaving home", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 859, height: 819 });
    await page.addInitScript(() => {
      const calls: string[] = [];
      Object.defineProperty(window, "__octosWindowOpenCalls", {
        value: calls,
        configurable: true,
      });
      window.open = ((url?: string | URL, name?: string, features?: string) => {
        calls.push(`${String(url ?? "")}|${name ?? ""}|${features ?? ""}`);
        return null;
      }) as typeof window.open;
    });

    await page.goto("/home", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Sound on", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Bilibili music" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sound off", exact: true })).toBeVisible();
    const audioFrame = page.locator("iframe[data-octos-bilibili-audio]");
    await expect(audioFrame).toHaveCount(1);
    await expect(audioFrame).toHaveAttribute(
      "src",
      /https:\/\/player\.bilibili\.com\/player\.html\?bvid=BV1cTcbzNE9p&autoplay=1&danmaku=0&high_quality=1/,
    );
    await expect(audioFrame).toHaveAttribute("allow", /autoplay/);
    await expect
      .poll(() =>
        page.evaluate(() => {
          return (
            window as typeof window & {
              __octosWindowOpenCalls?: string[];
            }
          ).__octosWindowOpenCalls?.length;
        }),
      )
      .toBe(0);

    await page.getByRole("button", { name: "Sound off", exact: true }).click();
    await expect(page.locator("iframe[data-octos-bilibili-audio]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sound on", exact: true })).toBeVisible();
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

  test("settings can restore the legacy blue global UI style", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("button", { name: "Legacy Blue" }).click();

    await expect
      .poll(() =>
        page.evaluate(() => ({
          attr: document.documentElement.getAttribute("data-ui-style"),
          stored: localStorage.getItem("octos-ui-style"),
          surfaceDark: getComputedStyle(document.documentElement)
            .getPropertyValue("--color-surface-dark")
            .trim()
            .toLowerCase(),
        })),
      )
      .toEqual({
        attr: "legacy-blue",
        stored: "legacy-blue",
        surfaceDark: "#081e3f",
      });

    await page.goto("/", { waitUntil: "networkidle" });

    await expect(page.locator(".legacy-blue-home")).toBeVisible();
    await expect(page.locator(".workbench-shell")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Start chat/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Slides/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Sites/i })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("settings exposes multiple warm interface palettes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: "Appearance" }).click();
    await expect(page.getByRole("button", { name: "Warm Hearth" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Garden Sage" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Soft Daylight" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Legacy Blue" })).toBeVisible();

    await page.getByRole("button", { name: "Garden Sage" }).click();

    await expect
      .poll(() =>
        page.evaluate(() => ({
          attr: document.documentElement.getAttribute("data-ui-style"),
          stored: localStorage.getItem("octos-ui-style"),
          link: getComputedStyle(document.documentElement)
            .getPropertyValue("--color-link")
            .trim()
            .toLowerCase(),
        })),
      )
      .toEqual({
        attr: "warm-sage",
        stored: "warm-sage",
        link: "#59784f",
      });
  });

  test("legacy blue home exposes a direct return to the warm workbench", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem("octos-ui-style", "legacy-blue");
      localStorage.setItem("octos-theme", "dark");
    });

    await page.goto("/", { waitUntil: "networkidle" });

    await expect(page.locator(".legacy-blue-home")).toBeVisible();
    await page.getByRole("button", { name: "Workbench" }).click();

    await expect(page.locator(".workbench-shell")).toBeVisible();
    await expect(page.locator(".legacy-blue-home")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("octos-ui-style")))
      .toBe("warm");
    await expect(
      page.getByRole("heading", { name: "Octos Workspace" }),
    ).toBeVisible();
  });

  test("slides editor composer stays below its message viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 859, height: 819 });
    await page.goto("/slides/deck-1", { waitUntil: "networkidle" });

    await expect(page.locator(".slides-editor-chat-panel")).toBeVisible();

    const layout = await page.evaluate(() => {
      const panel = document.querySelector(".slides-editor-chat-panel");
      const viewport = panel?.querySelector(".chat-thread-viewport");
      const composer = panel?.querySelector(".chat-composer-wrap");
      const panelRect = panel?.getBoundingClientRect();
      const viewportRect = viewport?.getBoundingClientRect();
      const composerRect = composer?.getBoundingClientRect();
      return {
        panelBottom: panelRect?.bottom ?? 0,
        viewportHeight: viewportRect?.height ?? 0,
        viewportBottom: viewportRect?.bottom ?? 0,
        composerTop: composerRect?.top ?? 0,
        composerBottom: composerRect?.bottom ?? 0,
      };
    });

    expect(layout.viewportHeight).toBeGreaterThanOrEqual(220);
    expect(layout.composerTop).toBeGreaterThanOrEqual(layout.viewportBottom - 1);
    expect(layout.composerBottom).toBeLessThanOrEqual(layout.panelBottom + 1);
  });

  test("content file panel keeps warm restrained control styling", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("crew:file", {
          detail: {
            fileUrl: "/api/files/pf/mock/family-plan.md",
            filename: "family-plan.md",
            caption: "Shared household notes",
            sessionId: "web-ui-smoke",
          },
        }),
      );
    });

    await page.getByTitle("Open files panel").click();
    await expect(page.getByText("Session Files")).toBeVisible();
    await expect(page.getByTestId("content-file-row")).toBeVisible();

    const styling = await page.evaluate(() => {
      const parseRadius = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? parseFloat(getComputedStyle(element).borderTopLeftRadius) : Number.NaN;
      };
      const panel = document.querySelector(".chat-media-panel-wrap .glass-panel");
      const hasOldRoundedClass = panel
        ? /rounded-\[(1[0-9]|[2-9][0-9])px\]|rounded-xl|rounded-2xl|rounded-3xl/.test(
            panel.innerHTML,
          )
        : true;
      return {
        panelRadius: parseRadius(".chat-media-panel-wrap .glass-panel"),
        toolbarRadius: parseRadius(".chat-media-panel-wrap .glass-toolbar"),
        rowRadius: parseRadius("[data-testid='content-file-row']"),
        inputRadius: parseRadius(".chat-media-panel-wrap .workbench-input"),
        hasOldRoundedClass,
      };
    });

    expect(styling.panelRadius).toBeLessThanOrEqual(8);
    expect(styling.toolbarRadius).toBeLessThanOrEqual(8);
    expect(styling.rowRadius).toBeLessThanOrEqual(8);
    expect(styling.inputRadius).toBeLessThanOrEqual(8);
    expect(styling.hasOldRoundedClass).toBe(false);
    await expectNoHorizontalOverflow(page);
  });

  test("chat sidebar route navigation wraps without clipping", async ({ page }) => {
    await page.setViewportSize({ width: 1067, height: 787 });
    await page.goto("/chat", { waitUntil: "networkidle" });

    await expect(page.locator(".chat-sidebar-panel .chat-panel-toolbar")).toBeVisible();

    const layout = await page.evaluate(() => {
      const toolbar = document.querySelector(".chat-sidebar-panel .chat-panel-toolbar");
      const nav = toolbar?.querySelector(".workbench-route-nav");
      const links = Array.from(nav?.querySelectorAll(".workbench-route-link") ?? []);
      const toolbarRect = toolbar?.getBoundingClientRect();
      const navRect = nav?.getBoundingClientRect();
      const maxLinkOverflow = links.reduce((max, link) => {
        const rect = link.getBoundingClientRect();
        const overflow = Math.max(
          0,
          rect.right - (toolbarRect?.right ?? 0),
          (toolbarRect?.left ?? 0) - rect.left,
        );
        return Math.max(max, overflow);
      }, 0);

      return {
        visibleLinks: links.filter((link) => {
          const rect = link.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }).length,
        navScrollOverflow: nav ? nav.scrollWidth - nav.clientWidth : 0,
        navRight: navRect?.right ?? 0,
        toolbarRight: toolbarRect?.right ?? 0,
        maxLinkOverflow,
      };
    });

    expect(layout.visibleLinks).toBeGreaterThanOrEqual(7);
    expect(layout.navScrollOverflow).toBeLessThanOrEqual(1);
    expect(layout.navRight).toBeLessThanOrEqual(layout.toolbarRight + 1);
    expect(layout.maxLinkOverflow).toBeLessThanOrEqual(1);
  });
});

test.describe("Home conversation TTS smoke", () => {
  test("home assistant exposes TTS on completed assistant replies", async ({
    page,
  }) => {
    await installWorkbenchMocks(page, {
      messages: [
        {
          seq: 1,
          role: "user",
          content: "Summarize the room status",
          timestamp: "2026-01-01T00:00:00Z",
          client_message_id: "tts-thread",
          thread_id: "tts-thread",
          message_id: "user-tts",
          source: "user",
        },
        {
          seq: 2,
          role: "assistant",
          content: "The room is calm and ready.",
          timestamp: "2026-01-01T00:00:01Z",
          thread_id: "tts-thread",
          response_to_client_message_id: "tts-thread",
          message_id: "assistant-tts",
          source: "assistant",
        },
      ],
    });
    await page.setViewportSize({ width: 859, height: 819 });
    await page.goto("/home", { waitUntil: "networkidle" });

    await page.getByRole("button", { name: "Chat" }).click();
    await expect(page.locator(".home-conversation")).toBeVisible();
    await expect(page.getByText("The room is calm and ready.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Read response aloud" }),
    ).toBeVisible();
  });
});
