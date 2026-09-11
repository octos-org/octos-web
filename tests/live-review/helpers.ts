import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

type Account = { token: string; id: string; email: string };
export const credentials = JSON.parse(readFileSync(process.env.OCTOS_LIVE_REVIEW_CREDENTIALS!, "utf8")) as {
  a: Account; b: Account; owner: Account;
};
export const base = process.env.OCTOS_LIVE_REVIEW_URL!.replace(/\/?$/, "/");
export function appUrl(route: string) { return new URL(route.replace(/^\//, ""), base).href; }
export async function login(page: Page, account: Account = credentials.a, route = "chat") {
  await page.goto(appUrl(`login?redirect=${encodeURIComponent("/" + route)}`));
  await page.getByTestId("token-input").fill(account.token);
  await page.getByTestId("login-button").click();
  await expect(page).not.toHaveURL(/\/login/);
}
export async function send(page: Page, text: string) {
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("send-button").click();
}
export function assistantReply(page: Page, marker: string) {
  // Match rendered reply text independently from its adjacent timestamp.
  // `_1` followed by `17:05` otherwise falsely matches marker `_11`.
  return page.getByTestId("assistant-message").filter({ has: page.getByText(marker, { exact: true }) });
}
export async function chat(page: Page, marker: string) {
  const start = Date.now();
  await send(page, `Reply exactly ${marker}. Do not use tools.`);
  await expect(assistantReply(page, marker)).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("ghost-bubble")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("user-message").filter({ hasText: marker })).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("1969-12-31");
  await expect(page.getByTestId("cancel-button")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText("connection closed before turn completed");
  return Date.now() - start;
}
export function telemetry(page: Page, info: TestInfo) {
  const errors: string[] = [];
  const failures: { path: string; status: number }[] = [];
  const sockets = { opened: 0, closed: 0 };
  const file = info.outputPath("metrics.jsonl");
  mkdirSync(path.dirname(file), { recursive: true });
  const record = (entry: object) => appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
  page.on("pageerror", error => { errors.push(error.message); record({ event: "pageerror", message: error.message }); });
  page.on("response", response => {
    if (response.status() >= 400) {
      const failure = { path: new URL(response.url()).pathname, status: response.status() };
      failures.push(failure); record({ event: "http_failure", ...failure });
    }
  });
  page.on("websocket", socket => {
    sockets.opened++; socket.on("close", () => { sockets.closed++; });
  });
  return { errors, failures, sockets, record };
}
