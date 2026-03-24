import { test, expect } from "@playwright/test";
import { login, sendAndWait, resetServer } from "./helpers";

test.describe("Adaptive routing", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await resetServer(page);
  });

  test("show adaptive status", async ({ page }) => {
    const r = await sendAndWait(page, "/adaptive", {
      label: "adaptive-status",
      maxWait: 30_000,
    });
    expect(r.responseLen).toBeGreaterThan(0);
    expect(r.responseText.toLowerCase()).toMatch(/adaptive|off|hedge|lane/);
  });

  test("switch to hedge mode", async ({ page }) => {
    const r = await sendAndWait(page, "/adaptive hedge", {
      label: "adaptive-hedge",
      maxWait: 30_000,
    });
    expect(r.responseLen).toBeGreaterThan(0);
    expect(r.responseText.toLowerCase()).toMatch(/hedge|adaptive/);
  });

  test("switch back to off mode", async ({ page }) => {
    // First set hedge
    await sendAndWait(page, "/adaptive hedge", {
      label: "set-hedge",
      maxWait: 30_000,
    });

    // Then set off
    const r = await sendAndWait(page, "/adaptive off", {
      label: "set-off",
      maxWait: 30_000,
    });
    expect(r.responseLen).toBeGreaterThan(0);
    expect(r.responseText.toLowerCase()).toMatch(/off|adaptive/);
  });

  test("message works after switching adaptive mode", async ({ page }) => {
    // Switch to lane mode
    await sendAndWait(page, "/adaptive lane", {
      label: "set-lane",
      maxWait: 30_000,
    });

    // Send a normal message — should work with lane routing
    const r = await sendAndWait(page, "What is the capital of France?", {
      label: "lane-msg",
      maxWait: 60_000,
    });
    expect(r.responseLen).toBeGreaterThan(0);
    expect(r.responseText.toLowerCase()).toContain("paris");

    // Reset to off
    await sendAndWait(page, "/adaptive off", {
      label: "reset-off",
      maxWait: 30_000,
    });
  });
});
