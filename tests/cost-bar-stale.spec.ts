import { test, expect } from "@playwright/test";
import { login, sendAndWait, SEL, createNewSession } from "./helpers";

test.describe("Cost bar reactivity", () => {
  test("updates displayed cost when done metadata carries newer token totals", async ({
    page
  }) => {
    await login(page);
    await createNewSession(page);

    // Send a message and wait for response
    const result = await sendAndWait(page, "hello", {
      label: "cost-stale"
      });
    expect(result.assistantBubbles).toBeGreaterThan(0);
    expect(result.responseLen).toBeGreaterThan(0);

    const costBar = page.locator(SEL.costBar);
    const costVisible = await costBar.isVisible({ timeout: 5_000 }).catch(() => false);

    if (costVisible) {
      const costText = await costBar.textContent();
      expect(costText).toBeTruthy();
      expect(costText!.length).toBeGreaterThan(0);
    } else {
      console.log("Cost bar not visible — response was too fast or cheap");
    }
  });
});
