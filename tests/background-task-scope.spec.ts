import { expect, test } from "@playwright/test";
import { login, createNewSession, SEL } from "./helpers";

test.describe("background task scoping", () => {
  test("failed task notification stays in its originating session", async ({ page }) => {
    await login(page);

    // Get current session ID
    const currentSession = await page.evaluate(() => {
      return localStorage.getItem("octos_current_session") || "unknown";
    });

    // Dispatch a mock task failure event for this session
    await page.evaluate(
      ({ sessionId }) => {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: {
              sessionId,
              task: {
                id: "task-test-failed",
                tool_name: "Test task",
                tool_call_id: "call-test",
                status: "failed",
                started_at: "2026-01-01T00:00:00Z",
                completed_at: "2026-01-01T00:00:05Z",
                output_files: [],
                error: "Test error message",
                session_key: "api:" + sessionId,
              },
            },
          }),
        );
      },
      { sessionId: currentSession },
    );

    // The error should be visible in the current session
    await page.waitForTimeout(2000);

    // Create a new session — the error should NOT appear there
    await createNewSession(page);
    await page.waitForTimeout(1000);

    // New session should not show the task error
    const errorInNewSession = await page
      .getByText("Test error message")
      .isVisible()
      .catch(() => false);
    expect(errorInNewSession).toBe(false);
  });
});
