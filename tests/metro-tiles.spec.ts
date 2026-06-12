import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("Metro tiles", () => {
  test("resizes a tile in edit mode and persists the layout", async ({ page }) => {
    await login(page);
    await page.evaluate(() => localStorage.removeItem("octos_home_metro_layout"));
    await page.goto("/home", { waitUntil: "networkidle" });

    await expect(page.locator(".metro-grid")).toBeVisible();
    await page.getByRole("button", { name: "Edit" }).click();

    const handle = page
      .locator('.metro-tile[data-tile-id="clock"] .metro-resize-handle')
      .first();
    await expect(handle).toBeVisible();

    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 + 110, {
      steps: 6,
    });
    await page.mouse.up();

    const savedClock = await page.evaluate(() => {
      const raw = localStorage.getItem("octos_home_metro_layout");
      return raw ? JSON.parse(raw).clock : null;
    });

    expect(savedClock?.w).toBeGreaterThan(4);
    expect(savedClock?.h).toBeGreaterThan(2);
  });
});
