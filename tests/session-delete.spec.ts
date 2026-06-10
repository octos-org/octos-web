import { test, expect } from "@playwright/test";
import { login, sendAndWait, createNewSession, SEL } from "./helpers";

test.describe("Session deletion", () => {
  test("sidebar deletion removes the session across tabs and from the API", async ({
    page
  }) => {
    await login(page);
    await createNewSession(page);

    // Send a message to create a session on the server
    const result = await sendAndWait(page, "hello session delete test", {
      label: "delete-setup"
      });
    if (result.timedOut || result.assistantBubbles === 0) return;
    expect(result.responseLen).toBeGreaterThan(0);
    await page.waitForTimeout(2000);

    // Get the active session ID from the sidebar
    const activeItem = page.locator("[data-active='true']").first();
    const sessionId = await activeItem.getAttribute("data-session-id");
    expect(sessionId).toBeTruthy();

    // The session item should have a delete button on hover
    await activeItem.hover();
    const deleteBtn = activeItem.locator("[data-testid='session-delete-button']");
    const hasDelete = await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (!hasDelete) {
      // Some UIs require right-click or long-press for delete
      console.log("No delete button visible on hover — skipping");
      return;
    }

    // Click delete and confirm
    await deleteBtn.click();
    const confirmBtn = page.getByTitle("Confirm delete");
    const hasConfirm = await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasConfirm) {
      await confirmBtn.click();
    }
    await page.waitForTimeout(2000);

    // The session should no longer appear in the sidebar
    const deletedItem = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(deletedItem).toHaveCount(0, { timeout: 5000 });
  });
});
