import { type Page, type Route, expect, test } from "@playwright/test";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "octos-admin-2026";
const BASE_URL = process.env.BASE_URL || "http://localhost:5174";
const USE_E2E_HARNESS = process.env.OCTOS_LIVE_E2E !== "1";

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

// ── Default deterministic E2E harness ──────────────────────────

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function rpcResponse(id: string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

type HarnessMessage = {
  seq: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  client_message_id?: string;
  thread_id?: string;
  response_to_client_message_id?: string;
  message_id?: string;
  source?: string;
  media?: string[];
};

type HarnessSession = {
  id: string;
  title?: string;
  messages: HarnessMessage[];
};

function extractTurnText(params: Record<string, unknown> | undefined): string {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  return input
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("\n")
    .trim();
}

function harnessReplyFor(message: string): string {
  const lower = message.toLowerCase();
  const exact = message.match(/(?:say|reply with)\s+exactly:\s*(.+)$/i);
  if (exact?.[1]) return exact[1].trim();
  if (lower.includes("capital of japan")) return "Tokyo.";
  if (lower.includes("capital of france")) return "Paris.";
  if (lower.includes("capital of australia")) return "Canberra.";
  if (lower.includes("capital of canada")) return "Ottawa.";
  if (lower.includes("capital of germany")) return "Berlin.";
  if (lower.includes("capital of brazil")) return "Brasilia.";
  if (lower.includes("capital of italy")) return "Rome.";
  if (lower.includes("capital of spain")) return "Madrid.";
  if (lower.includes("capital of egypt")) return "Cairo.";
  if (lower.includes("capital of peru")) return "Lima.";
  if (lower.includes("capital of sweden")) return "Stockholm.";
  if (lower.includes("capital of greece")) return "Athens.";
  if (lower.includes("capital of portugal")) return "Lisbon.";
  if (lower.includes("1+1") || lower.includes("1 + 1")) return "2.";
  if (lower.includes("2+2") || lower.includes("2 + 2")) return "4.";
  if (lower.includes("3+3") || lower.includes("3 + 3")) return "6.";
  const arithmetic = lower.match(/\b(\d+)\s*([+*x])\s*(\d+)\b/);
  if (arithmetic) {
    const left = Number(arithmetic[1]);
    const right = Number(arithmetic[3]);
    const op = arithmetic[2];
    if (Number.isFinite(left) && Number.isFinite(right)) {
      return String(op === "+" ? left + right : left * right);
    }
  }
  if (lower.includes("csv")) return "The CSV contains Alice, Bob, and Charlie.";
  if (lower.includes("markdown") || lower.includes("title")) {
    return "The document title is Test Document.";
  }
  if (lower.includes("rust")) {
    return "Rust is a systems programming language with memory safety, strong tooling, advantages, and tradeoffs.";
  }
  if (lower.startsWith("/queue")) return `Queue mode updated: ${message.replace("/queue", "").trim() || "followup"}.`;
  if (lower.includes("weather")) return "The weather response is sunny and mild.";
  if (lower.includes("tts") || message.includes("声音")) return "TTS task accepted. Audio generation is mocked in this E2E harness.";
  return `Mock response: ${message || "ok"}`;
}

async function installDefaultE2EHarness(page: Page) {
  const sessions = new Map<string, HarnessSession>();
  let adaptiveMode: "off" | "hedge" | "lane" = "off";
  let harnessProfile = {
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
      llm: {
        primary: { family_id: "openai", model_id: "gpt-5.4" },
        fallbacks: [],
      },
      home: null,
      channels: [],
      gateway: {
        max_history: null,
        max_iterations: null,
        system_prompt: null,
        max_concurrent_sessions: null,
        browser_timeout_secs: null,
        max_output_tokens: null,
      },
      env_vars: {},
      hooks: [],
      email: "admin@localhost",
      api_type: null,
      admin_mode: true,
      sandbox: {
        enabled: false,
        mode: "off",
        allow_network: false,
        docker: {
          image: "ubuntu:24.04",
          cpu_limit: null,
          memory_limit: null,
          pids_limit: null,
          mount_mode: "read_only",
          extra_binds: [],
        },
        read_allow_paths: [],
      },
      adaptive_routing: null,
      content_routing: null,
      plugins: { require_signed: false },
    },
  };

  const ensureSession = (id: string): HarnessSession => {
    let session = sessions.get(id);
    if (!session) {
      session = { id, messages: [] };
      sessions.set(id, session);
    }
    return session;
  };

  await page.addInitScript(
    ({ token, profile }) => {
      const win = window as typeof window & {
        __octosBridgeReadyCount?: number;
      };
      win.__octosBridgeReadyCount = 0;
      window.addEventListener("crew:bridge_connected", () => {
        win.__octosBridgeReadyCount = (win.__octosBridgeReadyCount ?? 0) + 1;
      });
      if (sessionStorage.getItem("__octos_e2e_harness_seeded") !== "1") {
        localStorage.clear();
        sessionStorage.setItem("__octos_e2e_harness_seeded", "1");
      }
      localStorage.setItem("octos_session_token", token);
      localStorage.setItem("octos_auth_token", token);
      localStorage.setItem("selected_profile", profile);
    },
    { token: AUTH_TOKEN, profile: process.env.PROFILE_ID || "admin" },
  );

  await page.route(/\/api\/auth\/status$/, (route) =>
    fulfillJson(route, {
      bootstrap_mode: false,
      email_login_enabled: true,
      admin_token_login_enabled: true,
      allow_self_registration: false,
    }),
  );
  await page.route(/\/api\/auth\/verify$/, (route) =>
    fulfillJson(route, {
      ok: true,
      token: AUTH_TOKEN,
      user: {
        id: "admin",
        email: "admin@localhost",
        name: "Admin",
        role: "admin",
        created_at: "2026-01-01T00:00:00Z",
        last_login_at: null,
      },
    }),
  );
  await page.route(/\/api\/auth\/me$/, (route) =>
    fulfillJson(route, {
      user: {
        id: "admin",
        email: "admin@localhost",
        name: "Admin",
        role: "admin",
        created_at: "2026-01-01T00:00:00Z",
        last_login_at: null,
      },
      profile: { profile: { id: "admin", name: "Admin" } },
      portal: {
        kind: "admin",
        home_profile_id: "admin",
        home_route: "/chat",
        can_access_admin_portal: true,
        can_manage_users: true,
        sub_account_limit: 5,
        accessible_profiles: [],
      },
    }),
  );
  await page.route(/\/api\/my\/profile$/, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        name?: string;
        enabled?: boolean;
        config?: typeof harnessProfile.config;
      };
      harnessProfile = {
        ...harnessProfile,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.config !== undefined ? { config: body.config } : {}),
        updated_at: new Date().toISOString(),
      };
    }
    await fulfillJson(route, harnessProfile);
  });
  await page.route(/\/api\/status$/, (route) =>
    fulfillJson(route, {
      version: "test",
      model: "mock-model",
      provider: "mock",
      uptime_secs: 1,
      agent_configured: true,
    }),
  );
  await page.route(/\/api\/upload$/, async (route) =>
    fulfillJson(route, ["uploads/e2e-fixture.txt"]),
  );
  await page.route(/\/api\/my\/content(?:\?.*)?$/, (route) =>
    fulfillJson(route, {
      entries: [
        {
          id: "content-1",
          filename: "report.md",
          path: "pf/mock/report.md",
          category: "report",
          size_bytes: 128,
          created_at: "2026-01-01T00:00:00Z",
          thumbnail_path: null,
          session_id: null,
          tool_name: null,
          caption: "Mock report",
        },
      ],
      total: 1,
    }),
  );
  await page.route(/\/api\/files\/.+$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.from("mock file"),
    }),
  );

  await page.routeWebSocket(/\/api\/ui-protocol\/ws/, (ws) => {
    ws.onMessage((raw) => {
      let data: { id?: string; method?: string; params?: Record<string, unknown> };
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = data.id;
      const method = data.method;
      const params = data.params;

      if (method === "session/open" && id) {
        const sessionId = String(params?.session_id || "web-e2e");
        ensureSession(sessionId);
        ws.send(rpcResponse(id, {
          opened: { session_id: sessionId, active_profile_id: "admin" },
        }));
        ws.send(rpcNotification("router/status", {
          session_id: sessionId,
          mode: adaptiveMode,
          provider_count: 2,
        }));
        return;
      }

      if (method === "session/hydrate" && id) {
        ws.send(rpcResponse(id, { replayed_envelopes: [] }));
        return;
      }

      if (method === "session/list" && id) {
        ws.send(rpcResponse(id, {
          sessions: Array.from(sessions.values()).map((session) => ({
            id: session.id,
            title: session.title,
            message_count: session.messages.length,
          })),
        }));
        return;
      }

      if (method === "session/messages_page" && id) {
        const sessionId = String(params?.session_id || "");
        const session = ensureSession(sessionId);
        ws.send(rpcResponse(id, {
          messages: session.messages,
          has_more: false,
          next_offset: session.messages.length,
        }));
        return;
      }

      if (method === "session/status.get" && id) {
        ws.send(rpcResponse(id, {
          active: false,
          has_deferred_files: false,
          has_bg_tasks: false,
        }));
        return;
      }

      if (method === "session/tasks.list" && id) {
        ws.send(rpcResponse(id, { tasks: [] }));
        return;
      }

      if (method === "session/files.list" && id) {
        ws.send(rpcResponse(id, { files: [] }));
        return;
      }

      if (method === "content/list" && id) {
        ws.send(rpcResponse(id, {
          entries: [
            {
              id: "content-1",
              filename: "report.md",
              path: "pf/mock/report.md",
              category: "report",
              size_bytes: 128,
              created_at: "2026-01-01T00:00:00Z",
              thumbnail_path: null,
              session_id: null,
              tool_name: null,
              caption: "Mock report",
            },
          ],
          total: 1,
        }));
        return;
      }

      if (method === "session/title.set" && id) {
        const sessionId = String(params?.session_id || "");
        const title = String(params?.title || "");
        ensureSession(sessionId).title = title;
        ws.send(rpcResponse(id, { ok: true }));
        ws.send(rpcNotification("session/title-updated", {
          session_id: sessionId,
          title,
        }));
        return;
      }

      if (method === "session/delete" && id) {
        const sessionId = String(params?.session_id || "");
        sessions.delete(sessionId);
        ws.send(rpcResponse(id, { deleted: true }));
        return;
      }

      if (method === "router/get_metrics" && id) {
        ws.send(rpcResponse(id, {
          mode: adaptiveMode,
          provider_count: 2,
          providers: [],
        }));
        return;
      }

      if (method === "router/set_mode" && id) {
        const requested = params?.mode;
        adaptiveMode = requested === "hedge" || requested === "lane" ? requested : "off";
        const sessionId = String(params?.session_id || "");
        ws.send(rpcResponse(id, { mode: adaptiveMode }));
        ws.send(rpcNotification("router/status", {
          session_id: sessionId,
          mode: adaptiveMode,
          provider_count: 2,
        }));
        return;
      }

      if (method === "turn/interrupt" && id) {
        ws.send(rpcResponse(id, { interrupted: true }));
        return;
      }

      if (method === "turn/start" && id) {
        const sessionId = String(params?.session_id || "web-e2e");
        const turnId = String(params?.turn_id || `turn-${Date.now()}`);
        const session = ensureSession(sessionId);
        const userText = extractTurnText(params);
        const userSeq = session.messages.length + 1;
        session.messages.push({
          seq: userSeq,
          role: "user",
          content: userText,
          timestamp: new Date().toISOString(),
          client_message_id: turnId,
          thread_id: turnId,
          message_id: `user-${userSeq}`,
          source: "user",
        });
        const reply = harnessReplyFor(userText);
        const assistantSeq = session.messages.length + 1;
        session.messages.push({
          seq: assistantSeq,
          role: "assistant",
          content: reply,
          timestamp: new Date().toISOString(),
          thread_id: turnId,
          response_to_client_message_id: turnId,
          message_id: `assistant-${assistantSeq}`,
          source: "assistant",
        });
        if (!session.title && userText) session.title = userText.slice(0, 50);

        ws.send(rpcResponse(id, { accepted: true }));
        ws.send(rpcNotification("turn/started", {
          session_id: sessionId,
          turn_id: turnId,
        }));
        ws.send(rpcNotification("message/delta", {
          session_id: sessionId,
          turn_id: turnId,
          text: reply,
          message_id: `assistant-${assistantSeq}`,
        }));
        ws.send(rpcNotification("message/persisted", {
          session_id: sessionId,
          turn_id: turnId,
          thread_id: turnId,
          seq: assistantSeq,
          role: "assistant",
          message_id: `assistant-${assistantSeq}`,
          source: "assistant",
          cursor: { stream: "main", seq: assistantSeq },
          persisted_at: new Date().toISOString(),
        }));
        ws.send(rpcNotification("progress/updated", {
          session_id: sessionId,
          turn_id: turnId,
          kind: "token_cost_update",
          metadata: {
            input_tokens: 12,
            output_tokens: 8,
            session_cost: 0.0001,
            model: "mock-model",
          },
        }));
        ws.send(rpcNotification("turn/completed", {
          session_id: sessionId,
          turn_id: turnId,
          reason: "done",
        }));
        return;
      }

      if (method === "ping") return;
      if (id) ws.send(rpcResponse(id, {}));
    });
  });
}
// ── Thinking content detection ─────────────────────────────────

/** Detect GPT-5.5 thinking/status text that isn't real content. */
export function isThinkingContent(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^✦/.test(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(t) && t.length < 30) return true;
  if (t.length < 60 && /Thinking|Synthesizing|Processing/i.test(t)) return true;
  return false;
}


// ── Login ──────────────────────────────────────────────────────

export async function login(page: Page) {
  const profileId = process.env.PROFILE_ID || "admin";
  const testEmail = process.env.TEST_EMAIL || "admin@localhost";

  if (USE_E2E_HARNESS) {
    await installDefaultE2EHarness(page);
  }

  // Obtain a real session token via static_tokens verify before seeding
  // localStorage. Session tokens work for both HTTP and WebSocket auth.
  let effectiveToken = AUTH_TOKEN;
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const sessionToken = await page.evaluate(
      async ({ email, code }) => {
        try {
          const resp = await fetch("/api/auth/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, code }),
          });
          if (!resp.ok) return null;
          const data = await resp.json();
          return data.ok && data.token ? (data.token as string) : null;
        } catch {
          return null;
        }
      },
      { email: testEmail, code: AUTH_TOKEN },
    );
    if (sessionToken) effectiveToken = sessionToken;
  } catch {
    // verify not available; fall back to raw AUTH_TOKEN
  }

  await page.addInitScript(
    ({ token, profile }) => {
      localStorage.setItem("octos_session_token", token);
      localStorage.setItem("octos_auth_token", token);
      localStorage.setItem("selected_profile", profile);
    },
    { token: effectiveToken, profile: profileId },
  );
  await page.goto("/chat", { waitUntil: "networkidle" });

  // Check if we landed on chat
  const onChat = await page
    .locator(SEL.chatInput)
    .isVisible({ timeout: 15_000 })
    .catch(() => false);
  if (onChat) return;

  // Try navigating to chat page directly
  await page.goto("/chat", { waitUntil: "networkidle" });
  const chatVisible = await page
    .locator(SEL.chatInput)
    .isVisible({ timeout: 10_000 })
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

  await page.waitForSelector(SEL.chatInput, { timeout: 30_000 });
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

export interface RenderedAudioAttachment {
  filename: string;
  path: string;
  text: string;
}

export interface RenderedThreadBubble {
  role: "user" | "assistant";
  text: string;
  audioAttachments: RenderedAudioAttachment[];
}

export async function getRenderedAudioAttachments(
  page: Page,
): Promise<RenderedAudioAttachment[]> {
  return page.locator("[data-testid='audio-attachment']").evaluateAll((nodes) =>
    nodes.map((node) => {
      const el = node as HTMLElement;
      return {
        filename: el.dataset.filename || "",
        path: el.dataset.filePath || "",
        text: (el.textContent || "").trim(),
      };
    }),
  );
}

export async function getRenderedThreadBubbles(
  page: Page,
): Promise<RenderedThreadBubble[]> {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll(
      "[data-testid='user-message'], [data-testid='assistant-message']",
    );
    return Array.from(nodes).map((node) => {
      const el = node as HTMLElement;
      const role = el.dataset.testid?.includes("user") ? "user" : "assistant";
      const audioAttachments = Array.from(
        el.querySelectorAll("[data-testid='audio-attachment']"),
      ).map((attachment) => {
        const audioEl = attachment as HTMLElement;
        return {
          filename: audioEl.dataset.filename || "",
          path: audioEl.dataset.filePath || "",
          text: (audioEl.textContent || "").trim(),
        };
      });
      return {
        role,
        text: (el.textContent || "").trim(),
        audioAttachments,
      };
    });
  });
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
  hasRealContent: boolean;
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
  const { maxWait = 300_000, label = "", throwOnTimeout = true } = opts;
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

    // Primary: streaming stopped AND bubble count stable AND bubbles present
    // (0 bubbles after having some = bridge dropped, not completion)
    if (assistantCount === lastAssistantCount && !isStreaming && assistantCount > 0) {
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
      currentText === lastText &&
      !isThinkingContent(currentText)
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
    hasRealContent: !isThinkingContent(finalText?.trim() || ""),
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

async function getBridgeReadyCount(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const win = window as typeof window & {
        __octosBridgeReadyCount?: number;
      };
      return win.__octosBridgeReadyCount ?? 0;
    })
    .catch(() => 0);
}

async function waitForNextBridgeReady(
  page: Page,
  previousCount: number,
): Promise<void> {
  await page
    .waitForFunction(
      (count) => {
        const win = window as typeof window & {
          __octosBridgeReadyCount?: number;
        };
        return (win.__octosBridgeReadyCount ?? 0) > count;
      },
      previousCount,
      { timeout: 5_000 },
    )
    .catch(() => {});
}

/** Create a new session via sidebar button. */
export async function createNewSession(page: Page) {
  const bridgeReadyCount = await getBridgeReadyCount(page);
  await page.locator(SEL.newChatButton).click();

  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForTimeout(400);
    const dialogVisible = await page.evaluate(() => {
      return !!document.querySelector('[role="dialog"]');
    });
    if (!dialogVisible) break;

    const clicked = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return false;
      const btns = Array.from(dlg.querySelectorAll("button"));
      const chat = btns.find((b) => {
        const t = (b.textContent || "").replace(/\s+/g, " ");
        return /chat/i.test(t) && /general/i.test(t);
      });
      if (chat) { (chat as HTMLElement).click(); return true; }
      return false;
    });
    if (clicked) {
      await page.waitForTimeout(600);
      const gone = await page.evaluate(() => !document.querySelector('[role="dialog"]'));
      if (gone) break;
    }

    if (attempt >= 2) {
      const closeBtn = page.locator('[role="dialog"] button[aria-label="Close"]');
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(300);
      }
    }
  }

  await page.waitForSelector(SEL.chatInput, { state: "visible", timeout: 10_000 });
  await waitForNextBridgeReady(page, bridgeReadyCount);
  await page.waitForTimeout(300);
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

/** Reset server state: create a fresh session for clean test state. */
export async function resetServer(page: Page) {
  // /reset is not wired on web transport; just create a fresh session
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
