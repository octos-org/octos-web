import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { appUrl, chat, credentials, login, telemetry } from "./helpers";

test("30-minute remote core UX soak: real chat, navigation, history, and reconnect", async ({ page, context }, info) => {
  test.setTimeout(35 * 60_000);
  const metrics = telemetry(page, info);
  const started = Date.now();
  const durationMs = 30 * 60_000;
  const latencies: number[] = [];
  const alias = process.env.OCTOS_LIVE_REVIEW_SSH;
  const pid = process.env.OCTOS_LIVE_REVIEW_PID;
  if (!alias || !pid || !/^\d+$/.test(pid)) throw new Error("Remote soak requires SSH alias and numeric server PID.");
  // Keep long-running history independent from feature acceptance accounts.
  await login(page, credentials.owner);
  let cycle = 0;
  do {
    cycle++;
    const marker = `REMOTE_SOAK_${started}_${cycle}`;
    const latencyMs = await chat(page, marker);
    latencies.push(latencyMs);
    await page.reload();
    await expect(page.getByTestId("assistant-message").filter({ hasText: marker })).toHaveCount(1);
    await expect(page.getByTestId("user-message").filter({ hasText: marker })).toHaveCount(1);
    await page.goto(appUrl(cycle % 2 ? "slides" : "sites"));
    await expect(page.getByRole("heading", { name: cycle % 2 ? "Slides" : "Site Studio", exact: true })).toBeVisible();
    await page.goto(appUrl("chat"));
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("assistant-message").filter({ hasText: marker })).toHaveCount(1);
    if (cycle % 3 === 0) {
      await context.setOffline(true);
      await page.waitForTimeout(2000);
      await context.setOffline(false);
      await page.reload();
      await expect(page.getByTestId("assistant-message").filter({ hasText: marker })).toHaveCount(1);
    }
    const remoteProcess = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias,
      `ps -p ${pid} -o pid=,etime=,rss=,%cpu=`], { encoding: "utf8", timeout: 15_000 }).trim();
    expect(remoteProcess).not.toBe("");
    expect(metrics.errors).toEqual([]);
    expect(metrics.failures.filter(f => f.status >= 500)).toEqual([]);
    metrics.record({ event: "cycle", cycle, latencyMs, elapsedMs: Date.now() - started, remoteProcess, sockets: metrics.sockets });
    console.log(`Remote soak cycle ${cycle}: reply ${latencyMs} ms, elapsed ${Math.round((Date.now() - started) / 1000)} s`);
    if (cycle % 5 === 0) await page.screenshot({ path: info.outputPath(`cycle-${cycle}.png`) });
    // Bound model spend while keeping the actual authenticated browser and
    // WebSockets open continuously between operations.
    if (Date.now() - started < durationMs) await page.waitForTimeout(45_000);
  } while (Date.now() - started < durationMs);
  await chat(page, `REMOTE_SOAK_${started}_FINAL`);
  metrics.record({ event: "complete", elapsedMs: Date.now() - started, cycles: cycle, latencies, sockets: metrics.sockets });
  expect(Date.now() - started).toBeGreaterThanOrEqual(durationMs);
});
