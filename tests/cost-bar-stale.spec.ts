import { test, expect } from "@playwright/test";
import { createNewSession, sendAndWait, SEL } from "./helpers";

test.describe("Cost bar reactivity", () => {
  test("updates displayed cost when done metadata carries newer token totals", async ({
    page,
  }) => {
    await page.route("**/api/auth/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          bootstrap_mode: false,
          email_login_enabled: false,
          admin_token_login_enabled: true,
          allow_self_registration: false,
          scoped_profile: null,
        }),
      });
    });
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "u-test",
            email: "e2e@test.local",
            name: "E2E",
            role: "user",
            created_at: "2026-01-01T00:00:00Z",
            last_login_at: null,
          },
          profile: { profile: { id: "dspfac" } },
          portal: {
            kind: "owner",
            home_profile_id: "dspfac",
            home_route: "/",
            can_access_admin_portal: false,
            can_manage_users: false,
            sub_account_limit: 0,
            accessible_profiles: [],
          },
        }),
      });
    });
    await page.route("**/api/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/sessions/*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: "test",
          model: "moonshot@autodl/kimi-k2.5",
          provider: "moonshot",
          uptime_secs: 1,
          agent_configured: true,
        }),
      });
    });

    await page.addInitScript(() => {
      localStorage.setItem("octos_session_token", "e2e-test-token");
      localStorage.setItem("octos_auth_token", "e2e-test-token");
      localStorage.setItem("selected_profile", "dspfac");
    });
    await page.goto("/chat", { waitUntil: "networkidle" });
    await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
    await createNewSession(page);

    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      const sse = [
        'data: {"type":"cost_update","input_tokens":1000,"output_tokens":50,"session_cost":0.0085}\n\n',
        'data: {"type":"token","text":"stub reply"}\n\n',
        'data: {"type":"done","content":"stub reply","model":"moonshot@autodl/kimi-k2.5","tokens_in":30000,"tokens_out":2000,"session_cost":0.0228}\n\n',
      ].join("");

      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
        body: sse,
      });
    });

    const result = await sendAndWait(page, "hello", {
      label: "cost-stale",
      maxWait: 20_000,
    });
    expect(result.responseText).toContain("stub reply");

    const costBar = page.locator(SEL.costBar);
    await expect(costBar).toContainText("30,000 in / 2,000 out");
    await expect(costBar).toContainText("$0.0228");
    await expect(costBar).not.toContainText("$0.0085");
  });
});
