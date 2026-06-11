import { test, expect } from "@playwright/test";
import { login, sendAndWait, SEL, createNewSession } from "./helpers";

test.describe("Streaming fidelity", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await createNewSession(page);
  });

  test("response streams correctly and renders in assistant bubble", async ({ page }) => {
    const result = await sendAndWait(page, "What is 2 + 2? Answer briefly.", {
      label: "stream-test"
      });

    expect(result.assistantBubbles).toBe(1);
    expect(result.responseLen).toBeGreaterThan(0);
    expect(result.userBubbles).toBe(1);
  });

  test("response renders in assistant bubble with correct structure", async ({ page }) => {
    const result = await sendAndWait(
      page,
      "What is the capital of Japan? Answer in one sentence.",
      { label: "structure-test" },
    );

    expect(result.assistantBubbles).toBeGreaterThan(0);
    expect(result.responseText.toLowerCase()).toContain("tokyo");

    const userBubbles = page.locator(SEL.userMessage);
    const assistantBubbles = page.locator(SEL.assistantMessage);
    await expect(userBubbles).toHaveCount(1);
    await expect(assistantBubbles).toHaveCount(1);
  });
});
