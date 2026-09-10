import { expect, test } from "@playwright/test";
import { appUrl, chat, credentials, login, send, telemetry } from "./helpers";

test("real chat settles, restores history, and survives a connection interruption", async ({ page, context }, info) => {
  const metrics = telemetry(page, info);
  await login(page);
  const marker = `LIVE_CHAT_${Date.now()}`;
  const latencyMs = await chat(page, marker);
  await page.reload();
  await expect(page.getByTestId("assistant-message").filter({ hasText: marker })).toHaveCount(1);
  await expect(page.getByTestId("user-message").filter({ hasText: marker })).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("1969-12-31");
  await context.setOffline(true);
  await page.waitForTimeout(2000);
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await chat(page, `${marker}_RECONNECTED`);
  metrics.record({ event: "complete", latencyMs, sockets: metrics.sockets });
  expect(metrics.errors).toEqual([]);
  expect(metrics.failures.filter(f => f.status >= 500)).toEqual([]);
});

test("queued real replies complete exactly once", async ({ page }, info) => {
  const metrics = telemetry(page, info);
  await login(page);
  const marker = `LIVE_QUEUE_${Date.now()}`;
  await send(page, `Write the numbers one through fifty, then end with ${marker}_FIRST. Do not use tools.`);
  await send(page, `Reply exactly ${marker}_SECOND. Do not use tools.`);
  await expect(page.getByTestId("assistant-message").filter({ hasText: `${marker}_SECOND` })).toHaveCount(1, { timeout: 180_000 });
  await expect(page.getByTestId("ghost-bubble")).toHaveCount(0);
  await expect(page.getByTestId("assistant-message").filter({ hasText: `${marker}_FIRST` })).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("user-message").filter({ hasText: marker })).toHaveCount(2);
  metrics.record({ event: "complete", sockets: metrics.sockets });
  expect(metrics.errors).toEqual([]);
});

test("fresh browser discovers real slide scaffold and its topic history", async ({ page, browser }, info) => {
  const metrics = telemetry(page, info);
  await login(page, credentials.a, "slides");
  await page.getByRole("button", { name: "New blank deck", exact: true }).click();
  await expect(page).toHaveURL(/\/slides\/slides-/);
  const projectUrl = page.url();
  await expect(page.getByText("script.js", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("assistant-message").filter({ hasText: /project.*created/i })).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("script.js", { exact: true }).first()).toBeVisible();
  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await login(other, credentials.a, "slides");
    const link = other.locator(`a[href="${new URL(projectUrl).pathname}"]`);
    await expect(link).toHaveCount(1);
    await link.click();
    await expect(other.getByText("script.js", { exact: true }).first()).toBeVisible();
    await expect(other.getByTestId("assistant-message").filter({ hasText: /project.*created/i })).toHaveCount(1);
  } finally { await fresh.close(); }
  metrics.record({ event: "complete", project: new URL(projectUrl).pathname });
  expect(metrics.errors).toEqual([]);
});

test("valid authentication survives a failed validation request", async ({ page }, info) => {
  const metrics = telemetry(page, info);
  await login(page);
  const before = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => /token/.test(key))));
  await page.route("**/api/auth/me", route => route.abort("connectionfailed"));
  await page.goto(appUrl("chat"));
  await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
  const during = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => /token/.test(key))));
  expect(JSON.stringify(during) === JSON.stringify(before)).toBe(true);
  await page.unroute("**/api/auth/me");
  await page.getByRole("button", { name: /retry/i }).click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  metrics.record({ event: "complete", preservedLogin: true });
  expect(metrics.errors).toEqual([]);
});
