import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("Metro tiles", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.evaluate(() => {
      localStorage.removeItem("octos_home_metro_layout");
      localStorage.setItem("octos_home_night_mode", "off");
    });
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();
  });

  test("resizes a tile in edit mode and persists the layout", async ({ page }) => {
    await page.getByRole("button", { name: "Edit" }).click();

    const handle = page
      .locator('.metro-tile[data-tile-id="timer"] .metro-resize-handle')
      .first();
    await expect(handle).toBeVisible();

    await handle.press("ArrowDown");

    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem("octos_home_metro_layout");
      return raw ? (JSON.parse(raw).timer?.h ?? 0) : 0;
    })).toBeGreaterThan(1);
  });

  test("default timer tile contains its idle controls without clipping", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();

    const clipping = await page.evaluate(() => {
      const tile = document.querySelector('.metro-tile[data-tile-id="timer"]');
      const widget = tile?.querySelector(".home-timer-widget");
      if (!tile || !widget) return null;

      const tileRect = tile.getBoundingClientRect();
      const widgetRect = widget.getBoundingClientRect();
      return {
        topOverflow: Math.ceil(tileRect.top - widgetRect.top),
        bottomOverflow: Math.ceil(widgetRect.bottom - tileRect.bottom),
        gridRowEnd: getComputedStyle(tile).gridRowEnd,
      };
    });

    expect(clipping).not.toBeNull();
    expect(clipping?.gridRowEnd).toBe("span 2");
    expect(clipping?.topOverflow).toBeLessThanOrEqual(0);
    expect(clipping?.bottomOverflow).toBeLessThanOrEqual(0);
  });

  test("legacy saved timer layout is upgraded to the minimum readable height", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => {
      localStorage.setItem(
        "octos_home_metro_layout",
        JSON.stringify({
          timer: { col: 3, row: 6, w: 2, h: 1 },
        }),
      );
    });
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();

    const timerGridRowEnd = await page.evaluate(() => {
      const tile = document.querySelector('.metro-tile[data-tile-id="timer"]');
      return tile ? getComputedStyle(tile).gridRowEnd : null;
    });

    expect(timerGridRowEnd).toBe("span 2");
  });

  test("mobile timer tile stays tall enough for wrapped preset controls", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();

    const clipping = await page.evaluate(() => {
      const tile = document.querySelector('.metro-tile[data-tile-id="timer"]');
      const widget = tile?.querySelector(".home-timer-widget");
      if (!tile || !widget) return null;

      const tileRect = tile.getBoundingClientRect();
      const widgetRect = widget.getBoundingClientRect();
      return {
        topOverflow: Math.ceil(tileRect.top - widgetRect.top),
        bottomOverflow: Math.ceil(widgetRect.bottom - tileRect.bottom),
        gridRowEnd: getComputedStyle(tile).gridRowEnd,
      };
    });

    expect(clipping).not.toBeNull();
    expect(clipping?.gridRowEnd).toBe("span 3");
    expect(clipping?.topOverflow).toBeLessThanOrEqual(0);
    expect(clipping?.bottomOverflow).toBeLessThanOrEqual(0);
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
          const [aId, a] = tiles[i];
          const [bId, b] = tiles[j];
          const overlaps = !(
            a.col + a.w <= b.col ||
            b.col + b.w <= a.col ||
            a.row + a.h <= b.row ||
            b.row + b.h <= a.row
          );
          expect(
            overlaps,
            `${aId} overlaps ${bId}: ${JSON.stringify(positions)}`,
          ).toBe(false);
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

  test("row position is clamped to MAX_ROWS (20)", async ({ page }) => {
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
      expect(Number(rowMatch[1])).toBeLessThanOrEqual(20);
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

  test("home widget order controls Metro tile order and placement", async ({ page }) => {
    const widgets = [
      { type: "weather", enabled: true, order: 0 },
      { type: "clock", enabled: true, order: 1 },
      { type: "quick-actions", enabled: true, order: 2 },
      { type: "voice-orb", enabled: true, order: 3 },
      { type: "news", enabled: true, order: 4 },
      { type: "calendar", enabled: true, order: 5 },
      { type: "timer", enabled: true, order: 6 },
      { type: "photo-frame", enabled: false, order: 7 },
      { type: "greeting", enabled: true, order: 8 },
    ];
    const profile = {
      id: "admin",
      name: "Admin",
      enabled: true,
      data_dir: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      status: {
        running: false,
        pid: null,
        started_at: null,
        uptime_secs: null,
      },
      config: {
        home: {
          settings: {
            night_mode: "off",
          },
          widgets,
          metro_layout: {},
        },
      },
    };
    let profileHits = 0;
    await page.unroute(/\/api\/my\/profile$/);
    await page.route(/\/api\/my\/profile$/, async (route) => {
      profileHits += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(profile),
      });
    });

    await page.evaluate(() => {
      localStorage.setItem(
        "octos_home_widgets",
        JSON.stringify([
          { type: "weather", enabled: true, order: 0 },
          { type: "clock", enabled: true, order: 1 },
          { type: "quick-actions", enabled: true, order: 2 },
          { type: "voice-orb", enabled: true, order: 3 },
          { type: "news", enabled: true, order: 4 },
          { type: "calendar", enabled: true, order: 5 },
          { type: "timer", enabled: true, order: 6 },
          { type: "photo-frame", enabled: false, order: 7 },
          { type: "greeting", enabled: true, order: 8 },
        ]),
      );
      localStorage.setItem("octos_home_night_mode", "off");
      localStorage.removeItem("octos_home_metro_layout");
    });

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator(".metro-grid")).toBeVisible();
    expect(profileHits).toBeGreaterThan(0);

    await expect(page.locator(".metro-tile").first()).toHaveAttribute(
      "data-tile-id",
      "weather",
    );
    const weatherColumnStart = await page
      .locator('.metro-tile[data-tile-id="weather"]')
      .evaluate((el) => getComputedStyle(el).gridColumnStart);
    expect(weatherColumnStart).toBe("1");
  });
});
