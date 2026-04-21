import { expect, test, type Route } from "@playwright/test";

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test.describe("Studio-disabled home flow", () => {
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

  test("does not expose Studio project entry points on the first page", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("button", { name: /New project/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Projects" })).toHaveCount(0);
    await expect(page.getByText("Create your first project")).toHaveCount(0);
    await expect(page.getByText("Legacy Studio project")).toHaveCount(0);

    await expect(page.getByRole("button", { name: /Start chat/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Slides/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Sites/i })).toBeVisible();
  });

  test("redirects stale Studio deep links to home", async ({ page }) => {
    await page.goto("/studio/studio-legacy");

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: /Start chat/i })).toBeVisible();
  });
});
