import { expect, test, type Page } from "@playwright/test";

test.skip(process.env.OCTOS_LIVE_E2E !== "1", "requires a live octos API server");

const LIVE_TIMEOUT = 30_000;

async function ensureSoloSession(page: Page): Promise<{ token: string; profileId: string }> {
  await page.goto("/login", { waitUntil: "networkidle" });

  const soloButton = page.getByTestId("solo-continue");
  await expect(soloButton).toBeVisible({ timeout: LIVE_TIMEOUT });
  await soloButton.click();

  const form = page.getByTestId("solo-profile-form");
  if (await form.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const suffix = Date.now().toString(36);
    await page.getByTestId("solo-name").fill(`Live Smoke ${suffix}`);
    await page.getByTestId("solo-username").fill(`live-smoke-${suffix}`);
    await page.getByTestId("solo-email").fill(`live-smoke-${suffix}@localhost`);
    await page.getByTestId("solo-submit").click();
  }

  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: LIVE_TIMEOUT,
  });

  const session = await page.evaluate(() => ({
    token: localStorage.getItem("octos_session_token") || localStorage.getItem("octos_auth_token") || "",
    profileId: localStorage.getItem("selected_profile") || "",
  }));

  expect(session.token).toBeTruthy();
  expect(session.profileId).toBeTruthy();
  return session;
}

async function liveApi<T>(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  return await page.evaluate(
    async ({ path, init }) => {
      const token =
        localStorage.getItem("octos_session_token") ||
        localStorage.getItem("octos_auth_token");
      const profileId = localStorage.getItem("selected_profile");
      const resp = await fetch(path, {
        method: init.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(profileId ? { "X-Profile-Id": profileId } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`${resp.status} ${text}`);
      }
      return text ? JSON.parse(text) : null;
    },
    { path, init },
  );
}

test.describe("live Settings and profile smoke", () => {
  test("loads Settings tabs without the mocked harness", async ({ page }) => {
    await ensureSoloSession(page);
    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: LIVE_TIMEOUT });

    for (const label of ["Profile", "LLM", "Skills", "Channels", "Sandbox", "Tools"]) {
      const tab = page.locator("aside button", { hasText: label }).first();
      await expect(tab).toBeVisible({ timeout: LIVE_TIMEOUT });
      await tab.click();
      await expect(page.locator("text=No profile available")).toHaveCount(0);
    }
  });

  test("persists Home config through the real profile endpoint", async ({ page }) => {
    await ensureSoloSession(page);
    const profile = await liveApi<Record<string, unknown>>(page, "/api/my/profile");
    const config = (profile.config ?? {}) as Record<string, unknown>;
    const suffix = Date.now().toString(36);

    const nextHome = {
      settings: {
        city: `Tokyo Live ${suffix}`,
        temp_unit: "C",
        clock_format: "24h",
        idle_seconds: 45,
        night_mode: "auto",
        lang: "en",
        news_feed_url: "https://feeds.bbci.co.uk/news/rss.xml",
      },
      events: [
        {
          id: `live-${suffix}`,
          title: "Live smoke dinner",
          date: "2026-06-14",
          time: "19:30",
        },
      ],
      widgets: [{ type: "weather", enabled: true, order: 3 }],
      metro_layout: { clock: { col: 1, row: 1, w: 4, h: 2 } },
    };

    await liveApi(page, "/api/my/profile", {
      method: "PUT",
      body: {
        name: profile.name,
        enabled: profile.enabled,
        config: { ...config, home: nextHome },
      },
    });

    const reloaded = await liveApi<Record<string, unknown>>(page, "/api/my/profile");
    const reloadedConfig = reloaded.config as Record<string, unknown>;
    expect(reloadedConfig.home).toMatchObject(nextHome);
  });
});
