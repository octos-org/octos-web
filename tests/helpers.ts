import { type Page, expect } from "@playwright/test";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";

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
  // Inject test token directly into localStorage (bypasses login UI)
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((token) => {
    localStorage.setItem("octos_session_token", token);
    localStorage.setItem("octos_auth_token", token);
  }, AUTH_TOKEN);
  await page.reload({ waitUntil: "networkidle" });

  // Should land on chat directly with valid token
  const onChat = await page.locator(SEL.chatInput).isVisible({ timeout: 10_000 }).catch(() => false);
  if (onChat) return;

  // If redirected to login, navigate to chat directly (token is in localStorage)
  await page.goto("/chat", { waitUntil: "networkidle" });
  await page.waitForSelector(SEL.chatInput, { timeout: 10_000 });
}

// ── Input helpers ──────────────────────────────────────────────

export function getInput(page: Page) {
  return page.locator(SEL.chatInput).first();
}

export function getSendButton(page: Page) {
  return page.locator(SEL.sendButton).first();
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
