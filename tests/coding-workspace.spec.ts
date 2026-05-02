import { test, expect, type Page } from "@playwright/test";

async function mockAuthenticatedApp(page: Page) {
  await page.route("**/api/auth/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        bootstrap_mode: false,
        email_login_enabled: true,
        admin_token_login_enabled: true,
        allow_self_registration: false,
      }),
    });
  });
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "test-user",
          email: "test@example.com",
          name: "Test User",
          role: "user",
          created_at: "2026-04-27T00:00:00Z",
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
  await page.addInitScript(() => {
    localStorage.setItem("octos_session_token", "test-token");
    localStorage.setItem("selected_profile", "dspfac");
  });
}

test.describe("coding workspace", () => {
  test("renders coding-only approval controls from UI Protocol events", async ({
    page,
  }) => {
    await mockAuthenticatedApp(page);
    await page.goto("/coding");

    await expect(page.getByText("AppUi / UI Protocol v1")).toBeVisible();
    const sessionId = await page
      .locator("[data-testid='coding-session-id']")
      .textContent();
    expect(sessionId).toContain(":api:coding-");

    await page.evaluate((session_id) => {
      window.dispatchEvent(
        new CustomEvent("octos:app-ui:event", {
          detail: {
            kind: "protocol",
            payload: {
              jsonrpc: "2.0",
              method: "approval/requested",
              params: {
                session_id,
                approval_id: "00000000-0000-0000-0000-000000000001",
                turn_id: "00000000-0000-0000-0000-000000000002",
                tool_name: "shell",
                title: "Run command",
                body: "Allow this coding command for the current request.",
                approval_kind: "command",
                typed_details: {
                  kind: "command",
                  command: {
                    command_line: "npm test -- coding-workspace.spec.ts",
                    cwd: "/workspace",
                  },
                },
              },
            },
          },
        }),
      );
    }, sessionId?.trim());

    await expect(page.locator("[data-testid='coding-approval-card']")).toBeVisible();
    await expect(page.getByText("npm test -- coding-workspace.spec.ts")).toBeVisible();

    await page.evaluate((session_id) => {
      window.dispatchEvent(
        new CustomEvent("octos:app-ui:event", {
          detail: {
            jsonrpc: "2.0",
            id: "session-open-1",
            result: {
              opened: {
                session_id,
                panes: {
                  workspace: {
                    entries: [{ path: "src/parser.rs", kind: "file" }],
                  },
                  artifacts: {
                    items: [{ title: "cargo-test.log", path: "target/log.txt" }],
                  },
                  git: {
                    status: [{ path: "src/parser.rs", status: "modified" }],
                    history: [{ commit: "abc123", summary: "initial" }],
                  },
                },
              },
            },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("octos:app-ui:event", {
          detail: {
            kind: "protocol",
            payload: {
              jsonrpc: "2.0",
              method: "task/updated",
              params: {
                session_id,
                task_id: "task-1",
                title: "Run cargo test",
                state: "running",
                output_tail: "running 6 tests",
              },
            },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("octos:app-ui:event", {
          detail: {
            jsonrpc: "2.0",
            id: "diff-1",
            result: {
              status: "ready",
              preview: {
                preview_id: "00000000-0000-0000-0000-000000000003",
                title: "Parser patch",
                files: [
                  {
                    path: "src/parser.rs",
                    status: "modified",
                    hunks: [
                      {
                        header: "@@ -1 +1 @@",
                        lines: [
                          { kind: "removed", content: "old", old_line: 1 },
                          { kind: "added", content: "new", new_line: 1 },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        }),
      );
    }, sessionId?.trim());

    await expect(page.locator("[data-testid='coding-workspace-pane']")).toContainText(
      "src/parser.rs",
    );
    await expect(page.locator("[data-testid='coding-artifacts-pane']")).toContainText(
      "cargo-test.log",
    );
    await expect(page.locator("[data-testid='coding-git-pane']")).toContainText(
      "modified",
    );
    await expect(page.locator("[data-testid='coding-task-output-pane']")).toContainText(
      "running 6 tests",
    );
    await expect(page.locator("[data-testid='coding-diff-preview']")).toContainText(
      "Parser patch",
    );

    await page.locator("[data-testid='coding-approval-deny']").click();
    await expect(page.locator("[data-testid='coding-approval-status']")).toHaveText(
      "denied",
    );

    await page.goto("/");
    await expect(page.locator("[data-testid='coding-approvals']")).toHaveCount(0);
  });
});
