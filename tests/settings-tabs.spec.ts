import { test, expect } from "@playwright/test";

/**
 * Smoke tests for the /settings page.
 *
 * These tests mock auth/profile/admin endpoints so they exercise the settings
 * UI deterministically without depending on a live backend on localhost.
 */

const TIMEOUT = 10_000;

interface SettingsMockOptions {
  profileUpdateError?: { status: number; body: unknown };
  allowedEmailDeleteError?: { status: number; body: unknown };
  operatorTasksError?: { status: number; body: unknown };
  ominixServiceActionErrors?: Partial<Record<"start" | "stop" | "restart", { status: number; body: unknown }>>;
  ominixHealthError?: { status: number; body: unknown };
  accessibleProfiles?: AccessibleProfileMock[];
}

interface AccessibleProfileMock {
  id: string;
  name: string;
  parent_id: string | null;
  relationship: string;
  api_scope: string;
  route_base: string;
  can_manage_sub_accounts: boolean;
}

const mockProfile = {
  id: "admin",
  name: "Admin",
  enabled: true,
  data_dir: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  status: {
    running: true,
    pid: 1234,
    started_at: "2026-01-01T00:00:00Z",
    uptime_secs: 3600,
  },
  config: {
    llm: {
      primary: { family_id: "openai", model_id: "gpt-5.4" },
      fallbacks: [],
    },
    channels: [],
    gateway: {
      max_history: null,
      max_iterations: null,
      system_prompt: null,
      max_concurrent_sessions: null,
      browser_timeout_secs: null,
      max_output_tokens: null,
    },
    env_vars: {},
    hooks: [],
    email: "admin@localhost",
    api_type: null,
    admin_mode: true,
    sandbox: {
      enabled: false,
      mode: "off",
      allow_network: false,
      docker: {
        image: "ubuntu:24.04",
        cpu_limit: null,
        memory_limit: null,
        pids_limit: null,
        mount_mode: "read_only",
        extra_binds: [],
      },
      read_allow_paths: [],
    },
    adaptive_routing: null,
    content_routing: null,
    plugins: { require_signed: false },
  },
};

async function installAdminSettingsMocks(
  page: import("@playwright/test").Page,
  options: SettingsMockOptions = {},
) {
  let enableBody: unknown = null;
  let disableBody: unknown = null;
  let downloadBody: unknown = null;
  let removeLocalBody: unknown = null;
  const profileHeaders: Array<string | null> = [];
  const serviceActions: string[] = [];
  const logLineRequests: number[] = [];
  const accessibleProfiles = options.accessibleProfiles ?? [
    {
      id: "admin",
      name: "Admin",
      parent_id: null,
      relationship: "self_profile",
      api_scope: "admin",
      route_base: "/",
      can_manage_sub_accounts: true,
    },
  ];

  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        bootstrap_mode: false,
        email_login_enabled: true,
        admin_token_login_enabled: true,
        allow_self_registration: false,
      }),
    }),
  );

  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "admin",
          email: "admin@localhost",
          name: "Admin",
          role: "admin",
          created_at: "2026-01-01T00:00:00Z",
          last_login_at: null,
        },
        profile: mockProfile,
        portal: {
          kind: "admin",
          home_profile_id: "admin",
          home_route: "/",
          can_access_admin_portal: true,
          can_manage_users: true,
          sub_account_limit: 10,
          accessible_profiles: accessibleProfiles,
        },
      }),
    }),
  );

  await page.route("**/api/my/profile", async (route) => {
    profileHeaders.push(route.request().headers()["x-profile-id"] ?? null);
    if (route.request().method() === "PUT" && options.profileUpdateError) {
      await route.fulfill({
        status: options.profileUpdateError.status,
        contentType: "application/json",
        body: JSON.stringify(options.profileUpdateError.body),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(mockProfile),
    });
  });

  await page.route("**/api/admin/platform-skills", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        platform_skills: [{ name: "voice", installed: true }],
        skills_dir: "/Users/yao/.octos/platform-skills",
        ominix_api: {
          url: "http://localhost:8080",
          healthy: true,
          service_registered: true,
        },
        models: {
          dir: "/Users/yao/.OminiX/models",
          asr: ["qwen3-asr-1.7b"],
          tts: ["qwen3-tts"],
        },
      }),
    }),
  );

  await page.route("**/api/admin/platform-skills/ominix-api/models", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          {
            id: "qwen3-asr-1.7b",
            name: "Qwen3 ASR",
            role: "asr",
            status: "ready",
            category: "speech",
            storage: { total_size_display: "1.7 GB" },
            runtime: { memory_required_mb: 4096 },
          },
          {
            id: "qwen3-tts",
            name: "Qwen3 TTS",
            role: "tts",
            status: "not_downloaded",
            category: "speech",
            storage: { total_size_display: "2.1 GB" },
            runtime: { memory_required_mb: 4096 },
          },
        ],
      }),
    }),
  );

  await page.route("**/api/admin/platform-skills/ominix-api/models/available", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          {
            id: "qwen3-asr-1.7b",
            name: "Qwen3 ASR",
            enabled_for_octos: true,
            role: "asr",
            status: "ready",
            category: "speech",
          },
          {
            id: "qwen3-tts",
            name: "Qwen3 TTS",
            enabled_for_octos: true,
            role: "tts",
            status: "not_downloaded",
            category: "speech",
          },
          {
            id: "parakeet-asr",
            name: "Parakeet ASR",
            enabled_for_octos: false,
            status: "not_downloaded",
            category: "speech",
          },
        ],
      }),
    }),
  );

  await page.route("**/api/admin/platform-skills/ominix-api/health", (route) => {
    if (options.ominixHealthError) {
      void route.fulfill({
        status: options.ominixHealthError.status,
        contentType: "application/json",
        body: JSON.stringify(options.ominixHealthError.body),
      });
      return;
    }
    void route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        name: "ominix-api",
        status: "healthy",
        url: "http://localhost:8080",
        detail: {
          version: "0.4.2",
          loaded_models: ["qwen3-asr-1.7b"],
        },
      }),
    });
  });

  await page.route("**/api/admin/platform-skills/ominix-api/logs?lines=*", (route) => {
    const url = new URL(route.request().url());
    const lines = Number(url.searchParams.get("lines") ?? "80");
    logLineRequests.push(lines);
    void route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        log_path: "/Users/yao/.ominix/api.log",
        total_lines: lines,
        lines: ["ominix-api booted", "catalog loaded", `${lines} log line request`],
      }),
    });
  });

  await page.route("**/api/admin/platform-skills/ominix-api/models/enable", async (route) => {
    enableBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "enabled" }),
    });
  });

  await page.route("**/api/admin/platform-skills/ominix-api/models/disable", async (route) => {
    disableBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "disabled" }),
    });
  });

  await page.route("**/api/admin/platform-skills/ominix-api/models/download", async (route) => {
    downloadBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "download started" }),
    });
  });

  await page.route("**/api/admin/platform-skills/ominix-api/models/remove", async (route) => {
    removeLocalBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "removed local model" }),
    });
  });

  for (const action of ["start", "stop", "restart"]) {
    await page.route(`**/api/admin/platform-skills/ominix-api/${action}`, async (route) => {
      serviceActions.push(action);
      const error = options.ominixServiceActionErrors?.[action as "start" | "stop" | "restart"];
      if (error) {
        await route.fulfill({
          status: error.status,
          contentType: "application/json",
          body: JSON.stringify(error.body),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, message: `${action}ed` }),
      });
    });
  }

  return {
    getEnableBody: () => enableBody,
    getDisableBody: () => disableBody,
    getDownloadBody: () => downloadBody,
    getRemoveLocalBody: () => removeLocalBody,
    getProfileHeaders: () => profileHeaders,
    getServiceActions: () => serviceActions,
    getLogLineRequests: () => logLineRequests,
  };
}

async function installServerSettingsMocks(
  page: import("@playwright/test").Page,
  options: SettingsMockOptions = {},
) {
  const baseMocks = await installAdminSettingsMocks(page, options);
  let watchdogBody: unknown = null;
  let deploymentBody: unknown = null;
  let rotateBody: unknown = null;
  let createdSubAccountBody: unknown = null;
  let testSearchBody: unknown = null;
  let testProviderBody: unknown = null;

  await page.route("**/api/admin/profiles", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([mockProfile]),
    }),
  );

  await page.route("**/api/admin/users", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        users: [
          {
            id: "admin",
            email: "admin@localhost",
            name: "Admin",
            role: "admin",
            created_at: "2026-01-01T00:00:00Z",
            last_login_at: "2026-01-02T00:00:00Z",
          },
        ],
      }),
    }),
  );

  await page.route("**/api/admin/allowed-emails", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          email: "new@localhost",
          created_at: "2026-01-01T00:00:00Z",
          registered: false,
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        entries: [
          {
            email: "allowed@localhost",
            created_at: "2026-01-01T00:00:00Z",
            registered: false,
          },
        ],
      }),
    });
  });

  await page.route("**/api/admin/allowed-emails/*", async (route) => {
    if (route.request().method() === "DELETE") {
      if (options.allowedEmailDeleteError) {
        await route.fulfill({
          status: options.allowedEmailDeleteError.status,
          contentType: "application/json",
          body: JSON.stringify(options.allowedEmailDeleteError.body),
        });
        return;
      }
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/admin/profiles/admin/accounts", async (route) => {
    createdSubAccountBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        email: null,
        profile: {
          ...mockProfile,
          id: "nana",
          name: "Nana",
          config: { ...mockProfile.config, email: "nana@example.com" },
        },
        status: {
          running: false,
          pid: null,
          started_at: null,
          uptime_secs: null,
        },
      }),
    });
  });

  await page.route("**/api/my/test-search", async (route) => {
    testSearchBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "Search API connected" }),
    });
  });

  await page.route("**/api/my/test-provider", async (route) => {
    testProviderBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, message: "OK" }),
    });
  });

  await page.route("**/api/admin/system/metrics", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        cpu: { usage_percent: 17.5 },
        memory: {
          total_bytes: 8 * 1024 * 1024 * 1024,
          used_bytes: 3 * 1024 * 1024 * 1024,
        },
        platform: { uptime_secs: 3661 },
      }),
    }),
  );

  await page.route("**/api/admin/operator/summary", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        collection: {
          running_gateways: 1,
          gateways_with_api_port: 1,
          gateways_missing_api_port: 0,
          scrape_failures: 0,
          sources_observed: 1,
          sources_with_metrics: 1,
          sources_without_metrics: 0,
          partial: false,
        },
        totals: {
          session_persists: 4,
          loop_errors: 0,
          loop_retries: 0,
          routing_decisions: 2,
          credential_rotations: 0,
          compaction_preservation_violations: 0,
          workspace_validator_required_failures: 0,
        },
        breakdowns: {
          routing_decisions: [{ tier: "cheap", count: 2 }],
        },
        sources: [
          {
            scope: "admin",
            scrape_status: "ok",
            available: true,
            sample_count: 4,
            totals: { session_persists: 4, loop_errors: 0 },
          },
        ],
      }),
    }),
  );

  await page.route("**/api/admin/operator/tasks", (route) => {
    if (options.operatorTasksError) {
      return route.fulfill({
        status: options.operatorTasksError.status,
        contentType: "application/json",
        body: JSON.stringify(options.operatorTasksError.body),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generated_at: "2026-01-01T00:00:00Z",
        stale_threshold_secs: 300,
        tasks: [],
        totals_by_lifecycle: { queued: 0, running: 0, failed: 0 },
        stale_count: 0,
        missing_artifact_count: 0,
        validator_failed_count: 0,
        sources: [],
        partial: false,
      }),
    });
  });

  await page.route("**/health", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "healthy",
        service: "octos",
        version: "0.1.1-test",
      }),
    }),
  );

  await page.route("**/api/admin/monitor/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        watchdog_enabled: true,
        alerts_enabled: false,
      }),
    }),
  );

  await page.route("**/api/admin/monitor/watchdog", async (route) => {
    watchdogBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, watchdog_enabled: false }),
    });
  });

  await page.route("**/api/admin/monitor/alerts", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, alerts_enabled: true }),
    }),
  );

  await page.route("**/api/admin/deployment-mode", async (route) => {
    if (route.request().method() === "POST") {
      deploymentBody = route.request().postDataJSON();
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ mode: "local", explicit: false }),
    });
  });

  await page.route("**/api/admin/deployment-mode/detect", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ detected: "tenant" }),
    }),
  );

  await page.route("**/api/admin/token/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ rotated: false }),
    }),
  );

  await page.route("**/api/admin/token/rotate", async (route) => {
    rotateBody = route.request().postDataJSON();
    await route.fulfill({ status: 204, body: "" });
  });

  return {
    ...baseMocks,
    getWatchdogBody: () => watchdogBody,
    getDeploymentBody: () => deploymentBody,
    getRotateBody: () => rotateBody,
    getCreatedSubAccountBody: () => createdSubAccountBody,
    getTestSearchBody: () => testSearchBody,
    getTestProviderBody: () => testProviderBody,
  };
}

async function seedAdminSession(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem("octos_session_token", "admin-token");
    localStorage.setItem("octos_auth_token", "admin-token");
    localStorage.setItem("selected_profile", "admin");
  });
}

/** Navigate to /settings after login. */
async function goToSettings(page: import("@playwright/test").Page) {
  await installServerSettingsMocks(page);
  await seedAdminSession(page);
  await page.goto("/settings", { waitUntil: "networkidle" });
  await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
}

/** Click a sidebar tab button by its visible label. */
async function clickTab(page: import("@playwright/test").Page, label: string) {
  const tab = page.locator("aside button", { hasText: label }).first();
  await tab.click();
  await page.waitForTimeout(500);
}

/** Whether the settings page has a loaded profile (vs "No profile available"). */
async function hasProfile(page: import("@playwright/test").Page): Promise<boolean> {
  const noProfile = page.locator("text=No profile available").first();
  return !(await noProfile.isVisible({ timeout: 2_000 }).catch(() => false));
}

// ── Tests ───────────────────────────────────────────────────────

test.describe("Settings page — tab smoke tests", () => {
  test("settings tab buttons are visible", async ({ page }) => {
    await goToSettings(page);

    const baseTabs = ["Profile", "LLM", "Skills", "Channels", "Sandbox", "Tools"];
    const adminTabs = ["Users", "System", "Server", "OminiX"];
    const profileLoaded = await hasProfile(page);

    for (const label of baseTabs) {
      await expect(
        page.locator("aside button", { hasText: label }).first(),
      ).toBeVisible({ timeout: TIMEOUT });
    }

    if (profileLoaded) {
      for (const label of adminTabs) {
        await expect(
          page.locator("aside button", { hasText: label }).first(),
        ).toBeVisible({ timeout: TIMEOUT });
      }
    }
  });

  test("profile switch persists and updates following API requests", async ({ page }) => {
    const mocks = await installServerSettingsMocks(page, {
      accessibleProfiles: [
        {
          id: "admin",
          name: "Admin",
          parent_id: null,
          relationship: "self_profile",
          api_scope: "admin",
          route_base: "/",
          can_manage_sub_accounts: true,
        },
        {
          id: "ops",
          name: "Ops",
          parent_id: "admin",
          relationship: "sub_account",
          api_scope: "profile",
          route_base: "/profiles/ops",
          can_manage_sub_accounts: false,
        },
      ],
    });
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });

    await page.locator("select.workbench-input").selectOption("ops");

    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("selected_profile")))
      .toBe("ops");
    await expect
      .poll(() => mocks.getProfileHeaders().at(-1))
      .toBe("ops");
  });

  test("Profile tab renders profile info and gateway status", async ({
    page,
  }) => {
    await goToSettings(page);
    await clickTab(page, "Profile");

    const profileLoaded = await hasProfile(page);
    if (profileLoaded) {
      await expect(
        page.locator("h3", { hasText: "Profile Information" }),
      ).toBeVisible({ timeout: TIMEOUT });
      await expect(
        page.locator("text=Display Name").first(),
      ).toBeVisible({ timeout: TIMEOUT });
      await expect(
        page.locator("h3", { hasText: "Gateway Status" }),
      ).toBeVisible({ timeout: TIMEOUT });
    } else {
      await expect(
        page.locator("text=No profile available").first(),
      ).toBeVisible({ timeout: TIMEOUT });
    }
  });

  test("Profile save surfaces backend validation errors", async ({ page }) => {
    await installServerSettingsMocks(page, {
      profileUpdateError: {
        status: 400,
        body: { detail: "Display name already exists" },
      },
    });
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "Profile");

    await page.getByPlaceholder("Enter display name").fill("Admin Duplicate");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(page.getByText("Display name already exists")).toBeVisible({
      timeout: TIMEOUT,
    });
  });

  test("LLM tab renders provider selector and fallback section", async ({
    page,
  }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "LLM");
    await expect(
      page.locator("h3", { hasText: "LLM Configuration" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("select").filter({ hasText: "Select a provider..." }).first(),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "Fallback Models" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("LLM tab tests provider with selected model and route data", async ({
    page,
  }) => {
    const mocks = await installServerSettingsMocks(page);
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "LLM");

    await page.getByRole("button", { name: "Test Connection" }).click();
    await expect.poll(() => mocks.getTestProviderBody()).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      api_key_env: "OPENAI_API_KEY",
      profile_id: "admin",
    });
    await expect(page.getByText("OK", { exact: true })).toBeVisible({
      timeout: TIMEOUT,
    });
  });

  test("Skills tab shows Installed Skills and Octos Hub", async ({
    page,
  }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Skills");
    await expect(
      page.locator("h3", { hasText: "Installed Skills" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "Octos Hub" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Channels tab renders Add Channel button", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Channels");
    await expect(
      page.locator("button", { hasText: "Add Channel" }).first(),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Sandbox tab renders configuration section", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Sandbox");
    await expect(
      page.locator("h3", { hasText: "Sandbox Configuration" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("text=Enable Sandbox").first(),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Tools tab renders Web Search APIs section", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Tools");
    await expect(
      page.locator("h3", { hasText: "Web Search APIs" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("Tools tab tests search keys through the real backend endpoint", async ({
    page,
  }) => {
    const mocks = await installServerSettingsMocks(page);
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "Tools");

    await page.getByPlaceholder("Enter Serper API key").fill("serper-key-valid");
    await page.getByRole("button", { name: "Test" }).first().click();

    await expect.poll(() => mocks.getTestSearchBody()).toEqual({
      provider: "serper",
      api_key: "serper-key-valid",
      api_key_env: "SERPER_API_KEY",
      profile_id: "admin",
    });
    await expect(page.getByText("Search API connected")).toBeVisible({
      timeout: TIMEOUT,
    });
  });

  test("System tab shows Operator Overview (admin)", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "System");
    await expect(
      page.locator("h3", { hasText: "Operator Overview" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("System tab surfaces partial operator task load failures", async ({ page }) => {
    await installServerSettingsMocks(page, {
      operatorTasksError: {
        status: 503,
        body: { detail: "operator tasks unavailable" },
      },
    });
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "System");

    await expect(
      page.locator("h3", { hasText: "Operator Overview" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(page.getByText("operator tasks unavailable")).toBeVisible({
      timeout: TIMEOUT,
    });
  });

  test("Server tab shows Deployment Mode (admin)", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Server");
    await expect(
      page.locator("h3", { hasText: "Server Info" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "Deployment Mode" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });

  test("OminiX tab wires allowlist, download, local remove, and service actions", async ({
    page,
  }) => {
    const mocks = await installAdminSettingsMocks(page);
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "OminiX");

    await expect(
      page.locator("h3", { hasText: "OminiX API" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(page.getByText("Healthy")).toBeVisible({ timeout: TIMEOUT });
    await expect(page.getByText("LaunchAgent registered")).toBeVisible();
    await expect(page.getByText("Qwen3 ASR").first()).toBeVisible();
    await expect(page.getByText("Qwen3 TTS").first()).toBeVisible();
    await expect(
      page.locator("h3", { hasText: "Enabled Platform Models" }),
    ).toBeVisible({ timeout: TIMEOUT });
    await expect(page.getByText("ominix-api booted")).toBeVisible();

    await page.getByRole("button", { name: "Download qwen3-tts" }).first().click();
    await expect(page.getByText("Download qwen3-tts?")).toBeVisible({
      timeout: TIMEOUT,
    });
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => mocks.getDownloadBody()).toEqual({
      model_id: "qwen3-tts",
    });

    await page.getByRole("button", { name: "Enable ASR parakeet-asr" }).click();
    await expect.poll(() => mocks.getEnableBody()).toEqual({
      model_id: "parakeet-asr",
      role: "asr",
    });

    await page.getByRole("button", { name: "Disable qwen3-asr-1.7b" }).first().click();
    await expect(
      page.getByText("Disable qwen3-asr-1.7b for Octos?"),
    ).toBeVisible({ timeout: TIMEOUT });
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => mocks.getDisableBody()).toEqual({
      model_id: "qwen3-asr-1.7b",
    });

    await page
      .getByRole("button", { name: "Remove local model qwen3-asr-1.7b" })
      .click();
    await expect(
      page.getByText("Remove local model qwen3-asr-1.7b?"),
    ).toBeVisible({ timeout: TIMEOUT });
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => mocks.getRemoveLocalBody()).toEqual({
      model_id: "qwen3-asr-1.7b",
    });

    await page.getByRole("button", { name: "Restart" }).click();
    await expect(
      page.getByText("restart ominix-api service?"),
    ).toBeVisible({ timeout: TIMEOUT });
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => mocks.getServiceActions()).toEqual(["restart"]);
  });

  test("OminiX service actions surface backend error details", async ({ page }) => {
    await installAdminSettingsMocks(page, {
      ominixServiceActionErrors: {
        restart: {
          status: 500,
          body: { detail: "launchctl failed" },
        },
      },
    });
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "OminiX");

    await page.getByRole("button", { name: "Restart" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByText("launchctl failed", { exact: true })).toBeVisible({
      timeout: TIMEOUT,
    });
    await expect(page.locator("h3", { hasText: "OminiX API" })).toBeVisible();
  });

  test("OminiX tab exposes health probe, log depth, and catalog filtering", async ({
    page,
  }) => {
    const mocks = await installAdminSettingsMocks(page);
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "OminiX");

    await expect(page.getByText("Health probe")).toBeVisible({ timeout: TIMEOUT });
    await expect(page.getByText("0.4.2")).toBeVisible();

    await page.getByRole("button", { name: "200 lines" }).click();
    await expect.poll(() => mocks.getLogLineRequests().at(-1)).toBe(200);
    await expect(page.getByText("200 log line request")).toBeVisible({
      timeout: TIMEOUT,
    });

    const catalog = page.locator("section", { hasText: "Available Catalog" });
    await catalog.getByPlaceholder("Search catalog...").fill("parakeet");
    await expect(catalog.getByText("Parakeet ASR")).toBeVisible();
    await expect(catalog.getByText("Qwen3 TTS")).toHaveCount(0);
  });

  test("Server tab uses real admin endpoints for settings and token rotation", async ({
    page,
  }) => {
    const mocks = await installServerSettingsMocks(page);
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "Server");

    await expect(page.getByText("0.1.1-test")).toBeVisible({ timeout: TIMEOUT });
    await expect(page.getByText("Detected: tenant")).toBeVisible();
    await expect(page.getByText("Bootstrap token has not been rotated")).toBeVisible();
    await expect(page.getByText("GET /api/admin/server")).toHaveCount(0);
    await expect(page.getByText("PATCH /api/admin/settings")).toHaveCount(0);

    await page.getByRole("switch").first().click();
    await expect.poll(() => mocks.getWatchdogBody()).toEqual({ enabled: false });

    await page.locator('input[name="deployment_mode"][value="cloud"]').check();
    await expect.poll(() => mocks.getDeploymentBody()).toEqual({ mode: "cloud" });

    await page
      .getByPlaceholder("New admin token, minimum 8 characters")
      .fill("new-admin-token");
    await page.getByRole("button", { name: "Rotate Token" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => mocks.getRotateBody()).toEqual({
      new_token: "new-admin-token",
    });
  });

  test("Users tab creates sub-account and reads allowlist entries", async ({
    page,
  }) => {
    const mocks = await installServerSettingsMocks(page);
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "Users");

    await expect(page.getByText("allowed@localhost")).toBeVisible({
      timeout: TIMEOUT,
    });
    await page.getByRole("button", { name: "Create Sub-Account" }).click();
    const subAccountForm = page.locator("form", { hasText: "New Sub-Account" });
    await subAccountForm.getByPlaceholder("user@example.com").fill("nana@example.com");
    await subAccountForm.getByPlaceholder("Display name").fill("Nana");
    await subAccountForm.getByRole("button", { name: "Create" }).click();

    await expect.poll(() => mocks.getCreatedSubAccountBody()).toEqual({
      sub_account_id: "nana",
      public_subdomain: "nana",
      name: "Nana",
      email: "nana@example.com",
    });
  });

  test("Users allowlist remove uses in-app confirmation and reports backend errors", async ({
    page,
  }) => {
    await installServerSettingsMocks(page, {
      allowedEmailDeleteError: {
        status: 500,
        body: { detail: "Allowlist delete failed" },
      },
    });
    await seedAdminSession(page);

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.locator(".animate-spin")).toBeHidden({ timeout: TIMEOUT });
    await clickTab(page, "Users");

    await page.getByTitle("Remove allowed@localhost").click();
    await expect(page.getByRole("heading", { name: "Remove Allowed Email" })).toBeVisible({
      timeout: TIMEOUT,
    });
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.getByRole("button", { name: "Remove Email" }).click();

    await expect(page.getByText("Allowlist delete failed")).toBeVisible({
      timeout: TIMEOUT,
    });
  });

  test("tab switching changes content", async ({ page }) => {
    await goToSettings(page);
    const profileLoaded = await hasProfile(page);
    if (!profileLoaded) { test.skip(); return; }

    await clickTab(page, "Profile");
    await expect(
      page.locator("h3", { hasText: "Profile Information" }),
    ).toBeVisible({ timeout: TIMEOUT });

    await clickTab(page, "LLM");
    await expect(
      page.locator("h3", { hasText: "Profile Information" }),
    ).toBeHidden({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "LLM Configuration" }),
    ).toBeVisible({ timeout: TIMEOUT });

    await clickTab(page, "Skills");
    await expect(
      page.locator("h3", { hasText: "LLM Configuration" }),
    ).toBeHidden({ timeout: TIMEOUT });
    await expect(
      page.locator("h3", { hasText: "Installed Skills" }),
    ).toBeVisible({ timeout: TIMEOUT });
  });
});
