import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("Metro tiles", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.evaluate(() => localStorage.removeItem("octos_home_metro_layout"));
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();
  });

  test("resizes a tile in edit mode and persists the layout", async ({ page }) => {
    await page.getByRole("button", { name: "Edit" }).click();

    const handle = page
      .locator('.metro-tile[data-tile-id="timer"] .metro-resize-handle')
      .first();
    await expect(handle).toBeVisible();

    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 110, {
      steps: 6,
    });
    await page.mouse.up();

    const savedTimer = await page.evaluate(() => {
      const raw = localStorage.getItem("octos_home_metro_layout");
      return raw ? JSON.parse(raw).timer : null;
    });

    expect(savedTimer?.h).toBeGreaterThan(1);
  });

  test("resize persists across reload", async ({ page }) => {
    await page.getByRole("button", { name: "Edit" }).click();

    const handle = page
      .locator('.metro-tile[data-tile-id="timer"] .metro-resize-handle')
      .first();
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 110, {
      steps: 4,
    });
    await page.mouse.up();

    const savedBefore = await page.evaluate(() => {
      const raw = localStorage.getItem("octos_home_metro_layout");
      return raw ? JSON.parse(raw).timer : null;
    });
    expect(savedBefore).not.toBeNull();

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();

    const savedAfter = await page.evaluate(() => {
      const raw = localStorage.getItem("octos_home_metro_layout");
      return raw ? JSON.parse(raw).timer : null;
    });
    expect(savedAfter?.w).toBe(savedBefore?.w);
    expect(savedAfter?.h).toBe(savedBefore?.h);
  });

  test("drag does not cause tile overlap", async ({ page }) => {
    await page.getByRole("button", { name: "Edit" }).click();

    const weatherTile = page.locator('.metro-tile[data-tile-id="weather"]');
    await expect(weatherTile).toBeVisible();
    const weatherBox = await weatherTile.boundingBox();
    if (!weatherBox) return;

    // Try to drag weather tile directly onto clock tile (col 1-4)
    await page.mouse.move(
      weatherBox.x + weatherBox.width / 2,
      weatherBox.y + weatherBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      weatherBox.x - 200,
      weatherBox.y,
      { steps: 6 },
    );
    await page.mouse.up();

    // Check that no tiles overlap by examining their grid positions
    const positions = await page.evaluate(() => {
      const raw = localStorage.getItem("octos_home_metro_layout");
      return raw ? JSON.parse(raw) : null;
    });

    if (positions) {
      const tiles = Object.entries(positions) as [string, { col: number; row: number; w: number; h: number }][];
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          const [, a] = tiles[i];
          const [, b] = tiles[j];
          const overlaps = !(
            a.col + a.w <= b.col ||
            b.col + b.w <= a.col ||
            a.row + a.h <= b.row ||
            b.row + b.h <= a.row
          );
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  test("mobile viewport clamps tiles to 4 columns", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();

    const gridCols = await page.evaluate(() => {
      const grid = document.querySelector(".metro-grid");
      if (!grid) return 0;
      const style = getComputedStyle(grid);
      return style.gridTemplateColumns.split(" ").filter(Boolean).length;
    });
    expect(gridCols).toBe(4);

    // Check that no tile extends beyond column 4
    const tilePositions = await page.evaluate(() => {
      const tiles = document.querySelectorAll(".metro-tile");
      return Array.from(tiles).map(t => {
        const style = t.getAttribute("style") || "";
        const colMatch = style.match(/grid-column:\s*(\d+)\s*\/\s*span\s*(\d+)/);
        return colMatch ? { col: Number(colMatch[1]), w: Number(colMatch[2]) } : null;
      }).filter(Boolean);
    });

    for (const pos of tilePositions) {
      if (pos) {
        expect(pos.col + pos.w - 1).toBeLessThanOrEqual(4);
      }
    }
  });

  test("row position is clamped to MAX_ROWS (12)", async ({ page }) => {
    // Set a layout with a tile at row 20
    await page.evaluate(() => {
      const layouts = {
        clock: { col: 1, row: 20, w: 4, h: 2 },
        weather: { col: 5, row: 1, w: 2, h: 2 },
      };
      localStorage.setItem("octos_home_metro_layout", JSON.stringify(layouts));
    });
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();

    const clockStyle = await page
      .locator('.metro-tile[data-tile-id="clock"]')
      .getAttribute("style");
    const rowMatch = clockStyle?.match(/grid-row:\s*(\d+)/);
    if (rowMatch) {
      expect(Number(rowMatch[1])).toBeLessThanOrEqual(12);
    }
  });

  test("resize handle is keyboard accessible", async ({ page }) => {
    await page.getByRole("button", { name: "Edit" }).click();

    const handle = page.locator(
      '.metro-tile[data-tile-id="timer"] .metro-resize-handle',
    );
    await expect(handle).toBeVisible();
    expect(await handle.getAttribute("role")).toBeNull();
    expect(await handle.evaluate(el => el.tagName.toLowerCase())).toBe("button");
    expect(await handle.getAttribute("aria-label")).toContain("Resize");
    expect(await handle.getAttribute("tabindex")).toBe("0");
    await handle.press("ArrowDown");

    const savedTimer = await page.evaluate(() => {
      const raw = localStorage.getItem("octos_home_metro_layout");
      return raw ? JSON.parse(raw).timer : null;
    });
    expect(savedTimer?.h).toBeGreaterThan(1);
  });
});
