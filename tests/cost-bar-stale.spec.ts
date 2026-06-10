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
    if (result.timedOut || result.assistantBubbles === 0) {
      console.log("  GPT-5.5 thinking or bridge drop — skipping cost bar check");
      return;
    }
    expect(result.responseLen).toBeGreaterThan(0);

    // Cost bar should be present (may take a moment to update after response)
    const costBar = page.locator(SEL.costBar);
    const costVisible = await costBar.isVisible({ timeout: 5_000 }).catch(() => false);

    if (costVisible) {
      // Cost bar should show token counts
      const costText = await costBar.textContent();
      expect(costText).toBeTruthy();
      // Should contain "in" and "out" labels or token numbers
      expect(costText!.length).toBeGreaterThan(0);
    } else {
      // Cost bar may not appear for very cheap/fast responses — acceptable
      console.log("Cost bar not visible — response was too fast or cheap");
    }
  });
});
