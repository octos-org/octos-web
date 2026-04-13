import { type Page, expect } from "@playwright/test";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "octos-admin-2026";
const BASE_URL = process.env.BASE_URL || "http://localhost:5174";

// ── Selectors (data-testid based) ──────────────────────────────

const SEL = {
  chatInput: "[data-testid='chat-input']",
  sendButton: "[data-testid='send-button']",
  cancelButton: "[data-testid='cancel-button']",
  userMessage: "[data-testid='user-message']",
  assistantMessage: "[data-testid='assistant-message']",
  sessionItem: "[data-session-id]",
  activeSession: "[data-active='true']",
  newChatButton: "[data-testid='new-chat-button']",
  cmdHints: "[data-testid='cmd-hints']",
  cmdFeedback: "[data-testid='cmd-feedback']",
  thinkingIndicator: "[data-testid='thinking-indicator']",
  toolProgress: "[data-testid='tool-progress']",
  costBar: "[data-testid='cost-bar']",
  loginTokenInput: "[data-testid='token-input']",
  loginButton: "[data-testid='login-button']",
  loginError: "[data-testid='login-error']",
} as const;

export { SEL };

// ── Login ──────────────────────────────────────────────────────

export async function login(page: Page) {
  const profileId = process.env.PROFILE_ID || "dspfac";
  const testEmail = process.env.TEST_EMAIL || "dspfac@gmail.com";

  // Inject test token and profile selection into localStorage
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ token, profile }) => {
      localStorage.setItem("octos_session_token", token);
      localStorage.setItem("octos_auth_token", token);
      localStorage.setItem("selected_profile", profile);
    },
    { token: AUTH_TOKEN, profile: profileId },
  );
  await page.reload({ waitUntil: "networkidle" });

  // Check if we landed on chat
  const onChat = await page
    .locator(SEL.chatInput)
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (onChat) return;

  // Try navigating to chat page directly
  await page.goto("/chat", { waitUntil: "networkidle" });
  const chatVisible = await page
    .locator(SEL.chatInput)
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (chatVisible) return;

  // Auth Token tab (admin token login)
  const authTokenTab = page.locator("button", { hasText: "Auth Token" });
  if (await authTokenTab.isVisible().catch(() => false)) {
    await authTokenTab.click();
    await page.locator(SEL.loginTokenInput).fill(AUTH_TOKEN);
    await page.locator(SEL.loginButton).click();
    const tokenChatVisible = await page
      .locator(SEL.chatInput)
      .isVisible({ timeout: 10_000 })
      .catch(() => false);
    if (tokenChatVisible) return;
  }

  // OTP login with static token — call verify API from within the browser
  // context so cookies/CORS work correctly. The backend's static_tokens
  // config allows AUTH_TOKEN to bypass real OTP verification.
  try {
    const apiLoginResult = await page.evaluate(
      async ({ email, code }) => {
        const resp = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data.ok || !data.token) return null;
        localStorage.setItem("octos_session_token", data.token);
        return data.token;
      },
      { email: testEmail, code: AUTH_TOKEN },
    );
    if (apiLoginResult) {
      await page.reload({ waitUntil: "networkidle" });
      const apiLoginVisible = await page
        .locator(SEL.chatInput)
        .isVisible({ timeout: 10_000 })
        .catch(() => false);
      if (apiLoginVisible) return;

      // Might land on home page — navigate to chat
      await page.goto("/chat", { waitUntil: "networkidle" });
      const chatAfterLogin = await page
        .locator(SEL.chatInput)
        .isVisible({ timeout: 10_000 })
        .catch(() => false);
      if (chatAfterLogin) return;
    }
  } catch {
    // API login failed — fall through to UI-based attempts
  }

  // If still on dashboard, click "Start" on the gateway, then navigate to chat
  const startBtn = page.locator("button", { hasText: "Start" });
  if (await startBtn.isVisible().catch(() => false)) {
    await startBtn.click();
    await page.waitForTimeout(5000);
  }

  // Try the messaging page
  const msgLink = page.locator("text=Messaging").first();
  if (await msgLink.isVisible().catch(() => false)) {
    await msgLink.click();
    await page.waitForTimeout(2000);
  }

  await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
}

// ── Input helpers ──────────────────────────────────────────────

export function getInput(page: Page) {
  return page.locator(SEL.chatInput).first();
}

export function getSendButton(page: Page) {
  return page.locator(SEL.sendButton).first();
}

export async function getChatThreadText(page: Page): Promise<string> {
  const texts = await page
    .locator("[data-testid='user-message'], [data-testid='assistant-message']")
    .allTextContents()
    .catch(() => []);
  return texts.join("\n");
}

// ── Send and wait ──────────────────────────────────────────────

export interface SendResult {
  totalBubbles: number;
  userBubbles: number;
  assistantBubbles: number;
  responseText: string;
  responseLen: number;
  elapsed: number;
  timedOut: boolean;
}

/**
 * Send a message and wait for the response to stabilize.
 * Throws on timeout unless `throwOnTimeout` is false.
 */
export async function sendAndWait(
  page: Page,
  message: string,
  opts: { maxWait?: number; label?: string; throwOnTimeout?: boolean } = {},
): Promise<SendResult> {
  const { maxWait = 120_000, label = "", throwOnTimeout = true } = opts;
  const input = getInput(page);
  const sendBtn = getSendButton(page);

  await input.fill(message);
  await sendBtn.click();

  const start = Date.now();
  let lastAssistantCount = 0;
  let lastText = "";
  let stableCount = 0;
  let textStableCount = 0;
  let timedOut = false;

  while (Date.now() - start < maxWait) {
    await page.waitForTimeout(3000);

    const isStreaming = await page
      .locator(SEL.cancelButton)
      .isVisible()
      .catch(() => false);

    const assistantCount = await page.locator(SEL.assistantMessage).count();

    // Get current text of last assistant bubble for text-stability check
    let currentText = "";
    if (assistantCount > 0) {
      currentText =
        (await page
          .locator(SEL.assistantMessage)
          .last()
          .textContent()
          .catch(() => "")) || "";
    }

    // Primary: streaming stopped AND bubble count stable
    if (assistantCount === lastAssistantCount && !isStreaming) {
      stableCount++;
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
    }

    // Fallback: text content stable for 3 consecutive checks (9s)
    // even if streaming indicator is stuck (common with server commands)
    if (
      assistantCount > 0 &&
      currentText.length > 0 &&
      currentText === lastText
    ) {
      textStableCount++;
      if (textStableCount >= 3) break;
    } else {
      textStableCount = 0;
    }

    lastAssistantCount = assistantCount;
    lastText = currentText;

    if (label) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(
        `  [${label}] ${elapsed}s: ${assistantCount} bubbles, streaming=${isStreaming}, textLen=${currentText.length}`,
      );
    }
  }

  if (Date.now() - start >= maxWait) {
    timedOut = true;
    if (throwOnTimeout) {
      throw new Error(
        `sendAndWait timed out after ${maxWait / 1000}s for message: "${message.slice(0, 60)}"`,
      );
    }
  }

  const userBubbles = await page.locator(SEL.userMessage).count();
  const assistantBubbles = await page.locator(SEL.assistantMessage).count();
  const lastBubble = page.locator(SEL.assistantMessage).last();
  const finalText =
    assistantBubbles > 0 ? await lastBubble.textContent() : "";

  return {
    totalBubbles: userBubbles + assistantBubbles,
    userBubbles,
    assistantBubbles,
    responseText: finalText?.trim() || "",
    responseLen: finalText?.trim().length || 0,
    elapsed: Date.now() - start,
    timedOut,
  };
}

// ── SSE event capture via network interception ─────────────────

export interface SseEvent {
  type: string;
  timestamp: number;
  raw: Record<string, unknown>;
}

/**
 * Intercept SSE events at the network level by monitoring the /api/chat response.
 * Much more reliable than console.log parsing.
 * Must be called BEFORE sendAndWait.
 */
export function captureSSEEvents(page: Page): SseEvent[] {
  const events: SseEvent[] = [];

  // Listen to console logs as primary capture
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[adapter] SSE event:")) {
      const match = text.match(/SSE event: (\w+)/);
      if (match) {
        events.push({
          type: match[1],
          timestamp: Date.now(),
          raw: { source: "console", text },
        });
      }
    }
  });

  // Also intercept at network level as fallback
  page.on("response", async (response) => {
    if (!response.url().includes("/api/chat")) return;
    const ct = response.headers()["content-type"] || "";
    if (!ct.includes("text/event-stream")) return;

    try {
      const body = await response.body();
      const text = body.toString("utf-8");
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type) {
            // Avoid duplicates from console capture
            const isDupe = events.some(
              (e) =>
                e.type === parsed.type &&
                e.raw.source !== "network" &&
                Math.abs(e.timestamp - Date.now()) < 2000,
            );
            if (!isDupe) {
              events.push({
                type: parsed.type,
                timestamp: Date.now(),
                raw: { source: "network", ...parsed },
              });
            }
          }
        } catch {
          // skip unparseable
        }
      }
    } catch {
      // response body may not be available for streaming
    }
  });

  return events;
}

// ── Session helpers ────────────────────────────────────────────

/** Create a new session via sidebar button. */
export async function createNewSession(page: Page) {
  await page.locator(SEL.newChatButton).click();
  await page.waitForTimeout(1000);
}

/** Count assistant message bubbles. */
export async function countAssistantBubbles(page: Page) {
  return page.locator(SEL.assistantMessage).count();
}

/** Count user message bubbles. */
export async function countUserBubbles(page: Page) {
  return page.locator(SEL.userMessage).count();
}

/** Get all session items in sidebar. */
export async function getSessionItems(page: Page) {
  return page.locator(SEL.sessionItem).all();
}

/** Switch to a session by clicking its sidebar item. */
export async function switchToSession(page: Page, index: number) {
  const items = await getSessionItems(page);
  if (index >= items.length) throw new Error(`Session index ${index} out of range (${items.length} sessions)`);
  await items[index].locator("[data-testid='session-switch-button']").click();
  await page.waitForTimeout(1500);
}

// ── Server state helpers ───────────────────────────────────────

/** Reset server state: queue mode, adaptive mode, and session history. */
export async function resetServer(page: Page) {
  await sendAndWait(page, "/reset", {
    label: "reset",
    maxWait: 30_000,
    throwOnTimeout: false,
  });
  // Create a fresh session after reset so subsequent tests start clean
  await createNewSession(page);
}

// ── Server log helpers (via admin shell API) ─────────────────

interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}

/**
 * Execute a shell command on the server via the admin shell API.
 * Returns null if the admin shell is not available.
 */
export async function adminShell(
  command: string,
  options: { timeoutSecs?: number; cwd?: string } = {},
): Promise<ShellResult | null> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/shell`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        command,
        cwd: options.cwd,
        timeout_secs: options.timeoutSecs ?? 10,
      }),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as ShellResult;
  } catch {
    return null;
  }
}

/**
 * Capture a log snapshot marker. Returns a timestamp that can be passed
 * to `getLogsSince()` to retrieve only logs from after this point.
 */
export async function markLogPosition(): Promise<string> {
  const result = await adminShell("date -u +%Y-%m-%dT%H:%M:%S");
  return result?.stdout.trim() ?? new Date().toISOString().slice(0, 19);
}

/**
 * Fetch server logs since a given timestamp, optionally filtered by pattern.
 * Uses `tail` + `awk` to efficiently filter large log files.
 */
export async function getLogsSince(
  since: string,
  options: { pattern?: string; lines?: number } = {},
): Promise<string[]> {
  const lines = options.lines ?? 5000;
  let cmd = `tail -${lines} ~/.octos/serve.log`;
  if (options.pattern) {
    cmd += ` | grep -i '${options.pattern.replace(/'/g, "'\\''")}'`;
  }
  // Filter by timestamp (logs are ISO 8601 prefixed)
  cmd += ` | awk '$0 >= "${since}"'`;
  const result = await adminShell(cmd, { timeoutSecs: 15 });
  if (!result?.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
}

/**
 * Assert that a specific event appeared in server logs since the marker.
 * Useful for verifying backend behavior that isn't visible in the UI.
 *
 * Example:
 *   const mark = await markLogPosition();
 *   await sendAndWait(page, "what's the weather in Paris?");
 *   await assertLogContains(mark, "get_weather", "expected get_weather tool call");
 */
export async function assertLogContains(
  since: string,
  pattern: string,
  message?: string,
): Promise<void> {
  const logs = await getLogsSince(since, { pattern });
  if (logs.length === 0) {
    const recent = await getLogsSince(since, { lines: 100 });
    const context = recent.slice(-10).join("\n  ");
    throw new Error(
      `${message ?? `Expected log pattern "${pattern}" not found`}\n` +
        `  Since: ${since}\n` +
        `  Recent logs:\n  ${context}`,
    );
  }
}

/**
 * Assert that NO matching log entries appeared since the marker.
 * Useful for verifying that errors or unwanted behavior didn't occur.
 */
export async function assertLogDoesNotContain(
  since: string,
  pattern: string,
  message?: string,
): Promise<void> {
  const logs = await getLogsSince(since, { pattern });
  if (logs.length > 0) {
    throw new Error(
      `${message ?? `Unexpected log pattern "${pattern}" found`}\n` +
        `  Since: ${since}\n` +
        `  Matched:\n  ${logs.slice(0, 5).join("\n  ")}`,
    );
  }
}

/**
 * Wait for a specific log pattern to appear, polling until timeout.
 * Useful for background tasks that complete asynchronously.
 */
export async function waitForLog(
  since: string,
  pattern: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string[]> {
  const timeout = options.timeoutMs ?? 30_000;
  const poll = options.pollMs ?? 2000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const logs = await getLogsSince(since, { pattern });
    if (logs.length > 0) return logs;
    await new Promise((r) => setTimeout(r, poll));
  }

  throw new Error(
    `Timed out waiting for log pattern "${pattern}" after ${timeout}ms`,
  );
}
