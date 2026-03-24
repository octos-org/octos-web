import { test, expect } from "@playwright/test";
import { login, sendAndWait, captureSSEEvents, SEL } from "./helpers";

test.describe("Streaming fidelity", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("SSE events arrive in correct order with no large gaps", async ({ page }) => {
    const events = captureSSEEvents(page);

    const result = await sendAndWait(page, "What is 2 + 2? Answer briefly.", {
      label: "stream-test",
      maxWait: 60_000,
    });

    expect(result.responseLen).toBeGreaterThan(0);
    expect(result.assistantBubbles).toBe(1);
    expect(result.userBubbles).toBe(1);

    // Should have captured some events
    expect(events.length).toBeGreaterThan(0);

    // Verify we got token or replace events
    const textEvents = events.filter(
      (e) => e.type === "token" || e.type === "replace",
    );
    expect(textEvents.length).toBeGreaterThan(0);

    // Verify no gaps > 30s between consecutive events
    for (let i = 1; i < events.length; i++) {
      const gap = events[i].timestamp - events[i - 1].timestamp;
      expect(gap).toBeLessThan(30_000);
    }

    // Log cost events for diagnostics
    const costEvents = events.filter((e) => e.type === "cost_update");
    console.log(`  cost_update events: ${costEvents.length}`);
  });

  test("response renders in assistant bubble with correct structure", async ({ page }) => {
    const result = await sendAndWait(
      page,
      "What is the capital of Japan? Answer in one sentence.",
      { label: "structure-test", maxWait: 60_000 },
    );

    expect(result.responseLen).toBeGreaterThan(0);
    expect(result.responseText.toLowerCase()).toContain("tokyo");

    // Verify bubble structure via data-testid
    const userBubbles = page.locator(SEL.userMessage);
    const assistantBubbles = page.locator(SEL.assistantMessage);
    await expect(userBubbles).toHaveCount(1);
    await expect(assistantBubbles).toHaveCount(1);
  });
});
