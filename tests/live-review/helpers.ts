import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

type Account = { token: string; id: string; email: string };
export const credentials = JSON.parse(readFileSync(process.env.OCTOS_LIVE_REVIEW_CREDENTIALS!, "utf8")) as {
  a: Account; b: Account; owner: Account;
};
export const base = process.env.OCTOS_LIVE_REVIEW_URL!.replace(/\/?$/, "/");
const terminalOutcomes = new WeakMap<Page, Map<string, string>>();
const hydratedTurnOrders = new WeakMap<Page, Map<string, string[]>>();
function observeTurnCompletion(page: Page) {
  if (terminalOutcomes.has(page)) return;
  const outcomes = new Map<string, string>();
  terminalOutcomes.set(page, outcomes);
  const orders = new Map<string, string[]>();
  hydratedTurnOrders.set(page, orders);
  page.on("websocket", socket => socket.on("framereceived", frame => {
    try {
      const event = JSON.parse(String(frame.payload));
      if (event.method === "projection/envelope" && event.params?.payload?.type === "turn_terminal") {
        outcomes.set(event.params.thread_id, event.params.payload.data.outcome);
      }
      if (event.result?.session_id && Array.isArray(event.result.messages)) {
        const messages = event.result.messages as { seq: number; role: string; thread_id?: string; turn_id?: string; client_message_id?: string }[];
        orders.set(event.result.session_id, [...messages].sort((a, b) => a.seq - b.seq)
          .filter(row => row.role === "user")
          .map(row => row.client_message_id ?? row.thread_id ?? row.turn_id ?? ""));
      }
    } catch { /* Binary/non-protocol frames are irrelevant to completion. */ }
  }));
}
export function appUrl(route: string) { return new URL(route.replace(/^\//, ""), base).href; }
export async function login(page: Page, account: Account = credentials.a, route = "chat") {
  observeTurnCompletion(page);
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
export async function expectTranscriptOrder(page: Page, latestMarker: string) {
  const latest = await assistantReply(page, latestMarker).getAttribute("data-thread-id");
  const expected = () => [...(hydratedTurnOrders.get(page)?.values() ?? [])]
    .find(order => latest !== null && order.includes(latest));
  await expect.poll(expected).toBeDefined();
  const order = expected()!;
  await expect.poll(() => page.getByTestId("user-message")
    .evaluateAll(nodes => nodes.map(node => node.getAttribute("data-thread-id"))))
    .toEqual(order);
  expect(new Set(order).size).toBe(order.length);
  expect(order.at(-1)).toBe(latest);
  return order.length;
}
export async function chat(page: Page, marker: string) {
  const start = Date.now();
  await send(page, `Reply exactly ${marker}. Do not use tools.`);
  await expect(assistantReply(page, marker)).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("ghost-bubble")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("user-message").filter({ hasText: marker })).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("1969-12-31");
  const thread = await assistantReply(page, marker).getAttribute("data-thread-id");
  // Persisted reply text and the streaming Stop control can settle before
  // the server terminal. A completed-turn reload must await that terminal.
  await expect.poll(() => terminalOutcomes.get(page)?.get(thread!), { timeout: 30_000 }).toBe("completed");
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
