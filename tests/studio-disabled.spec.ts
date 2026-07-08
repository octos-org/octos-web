import { expect, test, type Route } from "@playwright/test";

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test.describe("Legacy Studio handling", () => {
  test.beforeEach(async ({ page }) => {
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
          name: "Test User",
          role: "admin",
          created_at: "2026-04-21T00:00:00Z",
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
    await page.addInitScript(() => {
      localStorage.setItem("octos_session_token", "mock-token");
      localStorage.setItem("selected_profile", "dspfac");
      localStorage.setItem(
        "octos-studio-projects",
        JSON.stringify([
          {
            id: "studio-legacy",
            title: "Legacy Studio project",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            chatSessionId: "web-legacy",
            sources: [],
            outputs: [],
          },
        ]),
      );
    });
  });

  test("launcher exposes the new project entry points but never legacy Studio data", async ({ page }) => {
    await page.goto("/");

    // The revived Studio launches through the launcher's create card…
    await expect(page.getByRole("button", { name: /Create new project/i })).toBeVisible();
    // …but the deprecated "octos-studio-projects" records must never render.
    await expect(page.getByText("Legacy Studio project")).toHaveCount(0);

    // Production surfaces stay reachable from the glass nav.
    await expect(page.getByRole("link", { name: "Chat", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Slides", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sites", exact: true })).toBeVisible();
  });

  test("serves the revived studio workspace for web- ids", async ({ page }) => {
    await page.goto("/studio/web-e2e-positive");

    await expect(page).toHaveURL(/\/studio\/web-e2e-positive$/);
    await expect(page.getByTestId("studio-page")).toBeVisible();
    await expect(page.getByTestId("studio-title")).toBeVisible();
  });

  test("launcher create flow lands in a fresh studio workspace", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /Create new project/i }).click();
    await page.getByRole("button", { name: "Studio session", exact: true }).click();

    await expect(page).toHaveURL(/\/studio\/web-/);
    await expect(page.getByTestId("studio-page")).toBeVisible();
  });

  test("redirects stale Studio deep links to home", async ({ page }) => {
    // Legacy `studio-*` ids still redirect to `/`; only new-style
    // `web-*` ids open the revived /studio/:projectId workspace.
    await page.goto("/studio/studio-legacy");

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Octos Home" })).toBeVisible();

    // A bare /studio path (no project id) also lands back on the launcher.
    await page.goto("/studio");

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Octos Home" })).toBeVisible();
  });
});
