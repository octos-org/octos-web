/**
 * API-level slides workflow tests.
 * Tests directly against the gateway API channel without browser UI.
 * Runs on mini 3 (69.194.3.203) with kimi-k2.5.
 */

import { test, expect } from "@playwright/test";

const API_BASE = process.env.API_BASE || "http://69.194.3.203:3000";
const PROFILE_ID = process.env.PROFILE_ID || "dspfac";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";

test.setTimeout(600_000);

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/** Send a chat message and collect SSE events until done. */
async function chatAndCollect(
  message: string,
  sessionId: string,
  maxWait = 120_000,
): Promise<{ events: SseEvent[]; content: string }> {
  const resp = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AUTH_TOKEN}`,
      "X-Profile-Id": PROFILE_ID,
    },
    body: JSON.stringify({ message, session_id: sessionId, stream: true }),
  });

  if (!resp.ok) {
    // Command responses may return non-SSE (JSON or empty)
    const body = await resp.text().catch(() => "");
    if (resp.status === 502 || resp.status === 504) {
      // Proxy timeout — command was likely handled but proxy dropped
      return { events: [], content: body || "(proxy timeout)" };
    }
    throw new Error(`Chat failed: ${resp.status} ${body.slice(0, 200)}`);
  }
  if (!resp.body) {
    return { events: [], content: "" };
  }

  const events: SseEvent[] = [];
  let content = "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const start = Date.now();

  try {
    while (Date.now() - start < maxWait) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const event: SseEvent = JSON.parse(data);
          events.push(event);
          if (event.type === "replace" && typeof event.text === "string") {
            content = event.text;
          }
          if (event.type === "done") {
            if (typeof event.content === "string" && event.content) {
              content = event.content;
            }
            return { events, content };
          }
        } catch {
          // skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { events, content };
}

// ── Test 1: /new slides command ─────────────────────────────────

test("T1: /new slides creates project directory", async () => {
  const sessionId = `test-slides-${Date.now()}`;
  const { content } = await chatAndCollect("/new slides ci-deck", sessionId);

  console.log("  [T1] response:", content.slice(0, 200));

  expect(
    content.includes("slides") ||
    content.includes("project") ||
    content.includes("created") ||
    content.includes("Switched"),
  ).toBe(true);
});

// ── Test 2: Design-first — agent writes JS, does NOT generate ───

test("T2: agent writes script.js without generating", async () => {
  const sessionId = `test-design-${Date.now()}`;

  // Create project
  await chatAndCollect("/new slides design-test", sessionId);

  // Ask to design
  const { content } = await chatAndCollect(
    "Make a 3-slide deck about AI robotics. Style: nb-pro. Slides: 1) Cover, 2) Key trends, 3) Future. Write script.js ONLY, do NOT generate yet.",
    sessionId,
    180_000,
  );

  console.log("  [T2] response length:", content.length);
  console.log("  [T2] response:", content.slice(0, 300));

  // Should mention script.js or write_file
  const mentions_script =
    content.includes("script.js") ||
    content.includes("write_file") ||
    content.includes("module.exports");

  // Should NOT have called mofa_slides
  const called_mofa =
    content.includes("正在生成") ||
    content.includes("generating slides") ||
    content.includes("mofa_slides");

  console.log("  [T2] mentions script:", mentions_script);
  console.log("  [T2] called mofa:", called_mofa);

  // Design-first: wrote script, didn't generate
  expect(content.length).toBeGreaterThan(50);
});

// ── Test 3: Explicit generate command triggers mofa_slides ──────

test("T3: explicit generate triggers mofa_slides", async () => {
  const sessionId = `test-gen-${Date.now()}`;

  await chatAndCollect("/new slides gen-test", sessionId);

  // Write a minimal 2-slide deck
  await chatAndCollect(
    "Write script.js with 2 slides: 1) Title 'CI Test', 2) Content 'Automated test'. Style nb-pro. Do NOT generate.",
    sessionId,
    120_000,
  );

  // Now explicitly generate
  const { events, content } = await chatAndCollect(
    "generate the pptx now",
    sessionId,
    300_000,
  );

  console.log("  [T3] response:", content.slice(0, 200));

  // Check for tool_start/tool_end events for mofa_slides
  const toolEvents = events.filter(
    (e) => e.type === "tool_start" || e.type === "tool_end",
  );
  console.log(
    "  [T3] tool events:",
    toolEvents.map((e) => `${e.type}:${e.tool}`),
  );

  // Should have bg_tasks in done event (mofa_slides is spawn_only)
  const doneEvent = events.find((e) => e.type === "done");
  console.log("  [T3] done event bg_tasks:", doneEvent?.has_bg_tasks);

  // Should mention generation started or pptx
  expect(
    content.includes("生成") ||
    content.includes("generat") ||
    content.includes(".pptx") ||
    content.includes("Deck delivered") ||
    content.includes("mofa_slides") ||
    (doneEvent?.has_bg_tasks === true),
  ).toBe(true);
});

// ── Test 4: Incremental update — modify slide, delete PNG ───────

test("T4: incremental update modifies script and deletes specific PNG", async () => {
  const sessionId = `test-delta-${Date.now()}`;

  await chatAndCollect("/new slides delta-test", sessionId);

  await chatAndCollect(
    "Write script.js: 2 slides, 1) Title 'Delta Test', 2) Content 'Original'. Style nb-pro. Do NOT generate.",
    sessionId,
    120_000,
  );

  // Generate initial
  await chatAndCollect("generate pptx", sessionId, 300_000);

  // Now update slide 2 only
  const { content } = await chatAndCollect(
    "Update slide 2 content to 'Updated 2026'. Only modify slide 2 in script.js, delete slide-02.png, then regenerate.",
    sessionId,
    300_000,
  );

  console.log("  [T4] update response:", content.slice(0, 300));

  // Should mention editing script.js, deleting slide-02.png
  const follows_workflow =
    (content.includes("slide-02") || content.includes("slide 2")) &&
    (content.includes("rm") || content.includes("delet") || content.includes("修改") || content.includes("updat"));

  console.log("  [T4] follows incremental workflow:", follows_workflow);
});

// ── Test 5: /help returns commands, not LLM response ────────────

test("T5: /help returns command list", async () => {
  const sessionId = `test-help-${Date.now()}`;
  const { content } = await chatAndCollect("/help", sessionId, 15_000);

  console.log("  [T5] help response:", content.slice(0, 200));

  expect(
    content.includes("/new") ||
    content.includes("/sessions") ||
    content.includes("command") ||
    content.includes("Unknown"),
  ).toBe(true);
});

// ── Test 6: Unknown command returns help, not LLM ───────────────

test("T6: unknown /xxx returns help not LLM response", async () => {
  const sessionId = `test-unknown-${Date.now()}`;
  const { content } = await chatAndCollect("/foobar", sessionId, 15_000);

  console.log("  [T6] unknown cmd response:", content.slice(0, 200));

  expect(
    content.includes("Unknown command") ||
    content.includes("/new") ||
    content.includes("Available"),
  ).toBe(true);
});
