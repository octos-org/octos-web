import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * M10 hardening Test #3: cross-tab contention with the same auth token.
 *
 * Goal: two browser contexts (separate cookies/storage) using the SAME
 * admin token open the same profile's `/chat`, each create their own
 * session, send DIFFERENT prompts, and assert each tab sees only its own
 * conversation (no cross-pollination).
 *
 * Expected break (per handoff): server might route concurrent
 * turn/start RPCs from the same auth-token onto the same session_id, or
 * session-list polling might cross-pollute.
 */

const BASE_URL = process.env.BASE_URL || "https://dspfac.crew.ominix.io";
const TOKEN = process.env.OCTOS_AUTH_TOKEN || process.env.AUTH_TOKEN || "octos-admin-2026";
const PROFILE = process.env.OCTOS_PROFILE || process.env.PROFILE_ID || "dspfac";

async function bootstrap(ctx: BrowserContext): Promise<{ page: Page; sessionRef: { id: string | null } }> {
  const page = await ctx.newPage();
  // Capture the WS session_id this tab actually opens. Listening to
  // `websocket` and parsing the URL is the only way to verify each tab
  // landed on a DISTINCT session_id (codex feedback: a count-based check
  // false-passes on profiles that already have ≥2 sessions).
  const sessionRef: { id: string | null } = { id: null };
  page.on("websocket", (ws) => {
    if (sessionRef.id) return;
    const m = ws.url().match(/[?&]session_id=([^&]+)/);
    if (m) sessionRef.id = decodeURIComponent(m[1]);
    // session_id is also commonly carried as the first JSON-RPC param of
    // session/open; capture from the first sent frame as a fallback.
    ws.on("framesent", (data) => {
      if (sessionRef.id) return;
      const s = typeof data.payload === "string" ? data.payload : data.payload.toString("utf8");
      try {
        const j = JSON.parse(s);
        const sid = j?.params?.session_id || j?.params?.sessionId;
        if (typeof sid === "string" && sid.length > 0) sessionRef.id = sid;
      } catch { /* not JSON */ }
    });
  });
  await page.addInitScript(
    ({ token, profile }) => {
      localStorage.setItem("octos_session_token", token);
      localStorage.setItem("octos_auth_token", token);
      localStorage.setItem("selected_profile", profile);
      localStorage.setItem("chat_app_ui_v1", "1");
      localStorage.setItem("octos_thread_store_v2", "1");
    },
    { token: TOKEN, profile: PROFILE },
  );
  await page.goto(`${BASE_URL}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid='chat-input']", { timeout: 30_000 });
  await page.locator("[data-testid='new-chat-button']").click().catch(() => {});
  await page.waitForTimeout(1_000);
  return { page, sessionRef };
}

async function sendAndWaitForReply(page: Page, prompt: string, timeoutMs = 90_000) {
  const beforeUser = await page.locator("[data-testid='user-message']").count();
  const beforeAssistant = await page.locator("[data-testid='assistant-message']").count();
  await page.locator("[data-testid='chat-input']").first().fill(prompt);
  await page.locator("[data-testid='send-button']").first().click();
  await expect
    .poll(() => page.locator("[data-testid='user-message']").count(), {
      timeout: 30_000,
    })
    .toBe(beforeUser + 1);
  // Wait for an assistant bubble to render whose stripped (timestamp +
  // placeholder + non-letter) body has any meaningful glyph. The SPA
  // concatenates timestamp directly to body text in `textContent` (no
  // intervening whitespace), so the helper has to be tolerant: it
  // strips ANY leading or trailing `YYYY-MM-DD HH:MM:SS` run and
  // accepts whatever is left if it has at least one letter or CJK
  // character.
  const TS = /\d{4}-\d{2}-\d{2}[T\s]*\d{2}:\d{2}:\d{2}/g;
  const THINKING = /Thinking[\s.…]*\(iteration\s+\d+\)/gi;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const aCount = await page.locator("[data-testid='assistant-message']").count();
    if (aCount > beforeAssistant) {
      const last = await page
        .locator("[data-testid='assistant-message']")
        .last()
        .textContent();
      const stripped = (last || "").replace(/\s+/g, " ").trim();
      const real = stripped.replace(TS, "").replace(THINKING, "").trim();
      // Accept anything with at least 1 letter / digit / CJK glyph.
      if (real.length > 0 && /[\p{L}\p{N}]/u.test(real)) return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`assistant reply did not arrive within ${timeoutMs}ms`);
}

async function getAllText(page: Page): Promise<string> {
  return await page
    .locator("[data-testid='user-message'], [data-testid='assistant-message']")
    .allTextContents()
    .then((arr) => arr.join("\n"))
    .catch(() => "");
}

// Live-probe-only: this spec hits a real production host (mini1) and
// creates real sessions — never run during default `npm test` / CI
// playwright runs. Gate behind OCTOS_LIVE_PROBE=1.
const LIVE_PROBE = process.env.OCTOS_LIVE_PROBE === "1";
test.skip(!LIVE_PROBE, "OCTOS_LIVE_PROBE=1 required (live mini1 hits)");

test("M10 harden: two contexts with same token, separate sessions", async ({ browser }) => {
  test.setTimeout(900_000);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  const PROMPT_A = "What is 2 plus 3? Reply with just the number.";
  const PROMPT_B = "What is the capital of France? One word reply.";

  try {
    const [{ page: pageA, sessionRef: refA }, { page: pageB, sessionRef: refB }] =
      await Promise.all([bootstrap(ctxA), bootstrap(ctxB)]);

    // Send concurrently — race the two turn/start RPCs.
    await Promise.all([
      sendAndWaitForReply(pageA, PROMPT_A, 120_000),
      sendAndWaitForReply(pageB, PROMPT_B, 120_000),
    ]);

    const textA = await getAllText(pageA);
    const textB = await getAllText(pageB);

    console.log("--- tab A bubbles ---\n" + textA.slice(0, 800));
    console.log("--- tab B bubbles ---\n" + textB.slice(0, 800));

    // Tab A must contain its own prompt and NOT the other tab's.
    expect(textA, "tab A missing its own prompt").toContain("2 plus 3");
    expect(textA, "tab A leaked tab B's prompt").not.toContain("capital of France");
    expect(textB, "tab B missing its own prompt").toContain("capital of France");
    expect(textB, "tab B leaked tab A's prompt").not.toContain("2 plus 3");

    // Tab A's response should mention "5" or contain a digit answer; tab
    // B's response should mention "Paris". Strip trailing timestamps
    // first — the SPA concatenates them directly to body text in
    // textContent, with no whitespace boundary, so naive `\b5\b`
    // misses (`52026-05-06...`).
    const stripTs = (s: string) =>
      s
        .replace(/\d{4}-\d{2}-\d{2}[T\s]*\d{2}:\d{2}:\d{2}/g, " ")
        .toLowerCase();
    const lowerA = stripTs(textA);
    const lowerB = stripTs(textB);
    expect(lowerA, "tab A missing digit-5 answer").toMatch(/(^|\s)5(\s|$)|\bfive\b|五/);
    expect(lowerB, "tab B missing Paris answer").toMatch(/paris|巴黎/);

    // Distinct-session assertion (codex feedback): the previous version
    // was satisfied on any profile that already had ≥2 sessions, even if
    // both tabs raced onto the same session_id. We pinned the actual
    // session_ids each tab used at WS handshake time (sessionA / sessionB
    // captured via the websocket URL during turn/start). Assert they are
    // both populated AND not equal.
    const sessionA = refA.id;
    const sessionB = refB.id;
    console.log(`--- WS session ids: A=${sessionA} B=${sessionB} ---`);
    expect(sessionA, "tab A never opened a WS session").toBeTruthy();
    expect(sessionB, "tab B never opened a WS session").toBeTruthy();
    expect(
      sessionA,
      `tabs collided on same session_id ${sessionA} — cross-tab routing leaked`,
    ).not.toBe(sessionB);
  } finally {
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
  }
});
