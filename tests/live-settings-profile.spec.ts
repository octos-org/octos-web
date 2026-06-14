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

async function liveApiRaw(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; text: string; json: unknown | null }> {
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
      let json: unknown | null = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: resp.ok, status: resp.status, text, json };
    },
    { path, init },
  );
}

function expectObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  expect(value, label).toBeTruthy();
  expect(Array.isArray(value), label).toBe(false);
  expect(typeof value, label).toBe("object");
}

function expectArrayField<T = Record<string, unknown>>(
  value: unknown,
  field: string,
  label: string,
): T[] {
  expectObject(value, label);
  const arrayValue = value[field];
  expect(Array.isArray(arrayValue), `${label}.${field}`).toBe(true);
  return arrayValue as T[];
}

function firstStringField(value: unknown, fields: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  for (const field of fields) {
    const text = (value as Record<string, unknown>)[field];
    if (typeof text === "string" && text.trim()) return text;
  }
  return null;
}

async function expectNoRuntimeOverlay(page: Page) {
  const state = await page.evaluate(() => ({
    hasOverlay: Boolean(
      document.querySelector("[plugin-vite], vite-error-overlay, #webpack-dev-server-client-overlay"),
    ),
    horizontalOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    runtimeErrorText: /TypeError|ReferenceError|Cannot read properties|Internal server error/i.test(
      document.body.innerText,
    ),
  }));
  expect(state).toEqual({
    hasOverlay: false,
    horizontalOverflow: false,
    runtimeErrorText: false,
  });
}

async function clickSettingsTab(page: Page, label: string) {
  const tab = page.locator("aside button", { hasText: label }).first();
  await expect(tab).toBeVisible({ timeout: LIVE_TIMEOUT });
  await tab.click();
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

  test("loads profile Settings pages with live data", async ({ page }) => {
    await ensureSoloSession(page);
    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: LIVE_TIMEOUT });

    await clickSettingsTab(page, "Profile");
    await expect(page.getByRole("heading", { name: "Profile Information" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByRole("heading", { name: "Gateway Status" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expectNoRuntimeOverlay(page);

    await clickSettingsTab(page, "LLM");
    await expect(page.getByRole("heading", { name: "LLM Configuration" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByRole("heading", { name: "Fallback Models" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expectNoRuntimeOverlay(page);

    await clickSettingsTab(page, "Skills");
    await expect(page.getByRole("heading", { name: "Installed Skills" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByRole("heading", { name: "Octos Hub" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expectNoRuntimeOverlay(page);

    await clickSettingsTab(page, "Channels");
    await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByRole("button", { name: "Add Channel" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expectNoRuntimeOverlay(page);

    await clickSettingsTab(page, "Sandbox");
    await expect(page.getByRole("heading", { name: "Sandbox Configuration" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByText("Enable Sandbox")).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expectNoRuntimeOverlay(page);

    await clickSettingsTab(page, "Tools");
    await expect(page.getByRole("heading", { name: "Web Search APIs" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByText("Email Tool")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expectNoRuntimeOverlay(page);
  });

  test("loads admin Settings tabs and OminiX offline state without mocks", async ({ page }) => {
    await ensureSoloSession(page);
    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: LIVE_TIMEOUT });

    const usersTab = page.locator("aside button", { hasText: "Users" }).first();
    await expect(usersTab).toBeVisible({ timeout: LIVE_TIMEOUT });
    await usersTab.click();
    await expect(page.getByText("Create Sub-Account")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByText("Allowed Emails")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expectNoRuntimeOverlay(page);

    await page.locator("aside button", { hasText: "System" }).first().click();
    await expect(page.getByText("Operator Overview")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByText("Live Logs")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expectNoRuntimeOverlay(page);

    await page.locator("aside button", { hasText: "Server" }).first().click();
    await expect(page.getByText("Deployment Mode")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByText("Admin Token Status")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expectNoRuntimeOverlay(page);

    await page.locator("aside button", { hasText: "OminiX" }).first().click();
    await expect(page.getByRole("heading", { name: "OminiX API" })).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Enabled Platform Models" })).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Available Catalog" })).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible({ timeout: LIVE_TIMEOUT });
    const enabledModels = page.locator("section", { hasText: "Enabled Platform Models" });
    await expect(
      enabledModels.getByText("qwen3-asr-1.7b").first(),
    ).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(
      page.getByText("available models:", { exact: false }).first(),
    ).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByText("No catalog models returned")).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expectNoRuntimeOverlay(page);
  });

  test("binds admin Settings pages to live read-only data", async ({ page }) => {
    await ensureSoloSession(page);
    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: LIVE_TIMEOUT });

    const [
      users,
      allowedEmails,
      operatorSummary,
      operatorTasks,
      deploymentMode,
      systemMetrics,
      tokenStatus,
      platformSkills,
      enabledModels,
      availableModels,
    ] = await Promise.all([
      liveApiRaw(page, "/api/admin/users"),
      liveApiRaw(page, "/api/admin/allowed-emails"),
      liveApiRaw(page, "/api/admin/operator/summary"),
      liveApiRaw(page, "/api/admin/operator/tasks"),
      liveApiRaw(page, "/api/admin/deployment-mode"),
      liveApiRaw(page, "/api/admin/system/metrics"),
      liveApiRaw(page, "/api/admin/token/status"),
      liveApiRaw(page, "/api/admin/platform-skills"),
      liveApiRaw(page, "/api/admin/platform-skills/ominix-api/models"),
      liveApiRaw(page, "/api/admin/platform-skills/ominix-api/models/available"),
    ]);

    const userRows = expectArrayField(users.json, "users", "admin users");
    const allowlistRows = expectArrayField(allowedEmails.json, "entries", "allowed emails");
    expectObject(operatorSummary.json, "operator summary");
    const taskRows = expectArrayField(operatorTasks.json, "tasks", "operator tasks");
    expectObject(deploymentMode.json, "deployment mode");
    expectObject(systemMetrics.json, "system metrics");
    expectObject(tokenStatus.json, "token status");
    const skillRows = expectArrayField(platformSkills.json, "platform_skills", "platform skills");
    const modelRows = expectArrayField(enabledModels.json, "models", "enabled OminiX models");

    await clickSettingsTab(page, "Users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByRole("button", { name: "Create Sub-Account" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByRole("heading", { name: "Allowed Emails" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    const firstUserEmail = firstStringField(userRows[0], ["email"]);
    if (firstUserEmail) {
      await expect(page.getByText(firstUserEmail).first()).toBeVisible({ timeout: LIVE_TIMEOUT });
    } else {
      await expect(page.getByText("No registered accounts yet")).toBeVisible({
        timeout: LIVE_TIMEOUT,
      });
    }
    const firstAllowedEmail = firstStringField(allowlistRows[0], ["email"]);
    if (firstAllowedEmail) {
      await expect(page.getByText(firstAllowedEmail).first()).toBeVisible({ timeout: LIVE_TIMEOUT });
    } else {
      await expect(page.getByText("No allowlisted emails yet")).toBeVisible({
        timeout: LIVE_TIMEOUT,
      });
    }
    await expectNoRuntimeOverlay(page);

    await clickSettingsTab(page, "System");
    await expect(page.getByRole("heading", { name: "Operator Overview" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByText("Running Gateways")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Operator Tasks" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByRole("button", { name: /Live Logs/ })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    const firstTaskName = firstStringField(taskRows[0], ["tool_name", "id"]);
    if (firstTaskName) {
      await expect(page.getByText(firstTaskName).first()).toBeVisible({ timeout: LIVE_TIMEOUT });
    } else {
      await expect(page.getByText("No tasks in queue")).toBeVisible({ timeout: LIVE_TIMEOUT });
    }
    await expectNoRuntimeOverlay(page);

    await clickSettingsTab(page, "Server");
    for (const heading of [
      "Server Info",
      "Server Resources",
      "Reliability",
      "Deployment Mode",
      "Security",
      "All Profiles",
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toBeVisible({
        timeout: LIVE_TIMEOUT,
      });
    }
    const deploymentModeJson = deploymentMode.json as Record<string, unknown>;
    if (typeof deploymentModeJson.mode === "string") {
      await expect(
        page.locator(`input[name="deployment_mode"][value="${deploymentModeJson.mode}"]`),
      ).toBeChecked({ timeout: LIVE_TIMEOUT });
    }
    const tokenStatusJson = tokenStatus.json as Record<string, unknown>;
    if (typeof tokenStatusJson.rotated === "boolean") {
      await expect(
        page.getByText(
          tokenStatusJson.rotated
            ? "Rotated token is active"
            : "Bootstrap token has not been rotated",
        ),
      ).toBeVisible({ timeout: LIVE_TIMEOUT });
    }
    await expectNoRuntimeOverlay(page);

    await clickSettingsTab(page, "OminiX");
    await expect(page.getByRole("heading", { name: "OminiX API" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expect(page.getByText("Health probe")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Platform Skills" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    const firstSkill = firstStringField(skillRows[0], ["name"]);
    if (firstSkill) {
      await expect(page.getByText(firstSkill).first()).toBeVisible({ timeout: LIVE_TIMEOUT });
    } else {
      await expect(page.getByText("No platform skills returned")).toBeVisible({
        timeout: LIVE_TIMEOUT,
      });
    }
    await expect(page.getByRole("heading", { name: "Enabled Platform Models" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    const firstModel = firstStringField(modelRows[0], ["id", "name"]);
    if (firstModel) {
      await expect(page.getByText(firstModel).first()).toBeVisible({ timeout: LIVE_TIMEOUT });
    } else {
      await expect(page.getByText("No models are enabled for Octos")).toBeVisible({
        timeout: LIVE_TIMEOUT,
      });
    }
    await expect(page.getByRole("heading", { name: "Available Catalog" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    if (availableModels.status === 200) {
      await expect(page.getByText(/\d+ of \d+ models visible/)).toBeVisible({
        timeout: LIVE_TIMEOUT,
      });
    } else {
      await expect(page.getByText("No catalog models returned")).toBeVisible({
        timeout: LIVE_TIMEOUT,
      });
    }
    await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
    await expectNoRuntimeOverlay(page);
  });

  test("read-only Settings APIs return live contract-shaped data", async ({ page }) => {
    await ensureSoloSession(page);
    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: LIVE_TIMEOUT });

    const profileStatus = await liveApiRaw(page, "/api/my/profile/status");
    expect(profileStatus.status).toBe(200);
    const profileStatusJson = profileStatus.json;
    expectObject(profileStatusJson, "profile status");

    const profileSkills = await liveApiRaw(page, "/api/my/profile/skills");
    expect(profileSkills.status).toBe(200);
    const profileSkillsJson = profileSkills.json;
    expectObject(profileSkillsJson, "profile skills");
    expect(Array.isArray(profileSkillsJson.skills)).toBe(true);

    const users = await liveApiRaw(page, "/api/admin/users");
    expect(users.status).toBe(200);
    const usersJson = users.json;
    expectObject(usersJson, "admin users");
    expect(Array.isArray(usersJson.users)).toBe(true);

    const allowedEmails = await liveApiRaw(page, "/api/admin/allowed-emails");
    expect(allowedEmails.status).toBe(200);
    const allowedEmailsJson = allowedEmails.json;
    expectObject(allowedEmailsJson, "allowed emails");
    expect(Array.isArray(allowedEmailsJson.entries)).toBe(true);

    const operatorSummary = await liveApiRaw(page, "/api/admin/operator/summary");
    expect(operatorSummary.status).toBe(200);
    const operatorSummaryJson = operatorSummary.json;
    expectObject(operatorSummaryJson, "operator summary");

    const operatorTasks = await liveApiRaw(page, "/api/admin/operator/tasks");
    expect(operatorTasks.status).toBe(200);
    const operatorTasksJson = operatorTasks.json;
    expectObject(operatorTasksJson, "operator tasks");
    expect(Array.isArray(operatorTasksJson.tasks)).toBe(true);

    const monitorStatus = await liveApiRaw(page, "/api/admin/monitor/status");
    expect(monitorStatus.status).toBe(200);
    const monitorStatusJson = monitorStatus.json;
    expectObject(monitorStatusJson, "monitor status");
    expect(typeof monitorStatusJson.watchdog_enabled).toBe("boolean");

    const deploymentMode = await liveApiRaw(page, "/api/admin/deployment-mode");
    expect(deploymentMode.status).toBe(200);
    const deploymentModeJson = deploymentMode.json;
    expectObject(deploymentModeJson, "deployment mode");
    expect(typeof deploymentModeJson.mode).toBe("string");

    const deploymentDetect = await liveApiRaw(page, "/api/admin/deployment-mode/detect");
    expect(deploymentDetect.status).toBe(200);
    const deploymentDetectJson = deploymentDetect.json;
    expectObject(deploymentDetectJson, "deployment detection");
    expect(typeof deploymentDetectJson.detected).toBe("string");

    const systemMetrics = await liveApiRaw(page, "/api/admin/system/metrics");
    expect(systemMetrics.status).toBe(200);
    const systemMetricsJson = systemMetrics.json;
    expectObject(systemMetricsJson, "system metrics");

    const tokenStatus = await liveApiRaw(page, "/api/admin/token/status");
    expect(tokenStatus.status).toBe(200);
    const tokenStatusJson = tokenStatus.json;
    expectObject(tokenStatusJson, "token status");
    expect(typeof tokenStatusJson.rotated).toBe("boolean");

    const platformSkills = await liveApiRaw(page, "/api/admin/platform-skills");
    expect(platformSkills.status).toBe(200);
    const platformSkillsJson = platformSkills.json;
    expectObject(platformSkillsJson, "platform skills");
    expect(Array.isArray(platformSkillsJson.platform_skills)).toBe(true);

    const enabledModels = await liveApiRaw(page, "/api/admin/platform-skills/ominix-api/models");
    expect(enabledModels.status).toBe(200);
    const enabledModelsJson = enabledModels.json;
    expectObject(enabledModelsJson, "enabled OminiX models");
    expect(Array.isArray(enabledModelsJson.models)).toBe(true);
    expect(JSON.stringify(enabledModelsJson.models)).toContain("qwen3-asr-1.7b");

    const availableModels = await liveApiRaw(page, "/api/admin/platform-skills/ominix-api/models/available");
    expect([200, 502]).toContain(availableModels.status);
    if (availableModels.status === 200) {
      const availableModelsJson = availableModels.json;
      if (Array.isArray(availableModelsJson)) {
        expect(availableModelsJson.length).toBeGreaterThanOrEqual(0);
      } else {
        expectObject(availableModelsJson, "available OminiX catalog");
        expect(Array.isArray(availableModelsJson.models)).toBe(true);
      }
    } else {
      expect(availableModels.text).toContain("ominix-api");
    }

    await expectNoRuntimeOverlay(page);
  });

  test("persists Home config through the real profile endpoint", async ({ page }) => {
    test.skip(
      process.env.OCTOS_LIVE_E2E_MUTATE !== "1",
      "writes to the live profile; enable only for explicit mutation smoke",
    );

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
