import { expect, test, type WebSocket } from "@playwright/test";

/**
 * M10 hardening Test #7: late-token / WS-bridge race.
 *
 * Goal: simulate the real-world "user just verified OTP, browser
 * navigates immediately to /chat" scenario where the SPA may begin
 * hydrating (and the WS bridge may try to connect) BEFORE the auth
 * token is fully committed to localStorage. PR #80 added a defensive
 * fallback — verify it actually wins the race, or document the gap.
 *
 * Strategy: addInitScript runs BEFORE every navigation, but a script
 * with a `setTimeout(.., delayMs)` inside it stages the localStorage
 * writes for AFTER the SPA's first synchronous-mount tick. With a
 * delay around 50-200ms we land tokens roughly when the bridge has
 * already attempted its first WS open. This is a deterministic
 * proxy for the OTP-then-navigate race window.
 *
 * Expected break: WS opens before localStorage commit; bridge
 * getToken returns null; bridge fallback (PR #80) might or might not
 * help depending on timing.
 */

const BASE_URL = process.env.BASE_URL || "https://dspfac.crew.ominix.io";
const TOKEN = process.env.OCTOS_AUTH_TOKEN || "octos-admin-2026";
const PROFILE = process.env.OCTOS_PROFILE || "dspfac";
// 200ms is long enough to ensure the SPA has rendered and the bridge
// has attempted to read the token before localStorage is populated.
// Short enough that bridge fallback (poll/retry) should rescue if it
// works, surfacing the gap if it doesn't.
const TOKEN_DELAY_MS = 200;

// Live-probe-only: gate behind OCTOS_LIVE_PROBE=1 to prevent default
// `npm test` runs from hitting the production mini1.
const LIVE_PROBE = process.env.OCTOS_LIVE_PROBE === "1";
test.skip(!LIVE_PROBE, "OCTOS_LIVE_PROBE=1 required (live mini1 hits)");

// Codex round 8 finding: under the SPA's actual AuthGuard semantics, this
// test has no reliable passing-timing window. If the addInitScript timer
// fires AFTER first render → AuthGuard reads null token at mount, redirects
// to /login, chat-input never appears, test FAILs even though the bridge
// fallback is what we wanted to test. If the timer fires BEFORE first
// render → first WS open already carries the token, the
// "race-actually-fired" assertion FAILs. There is no in-between under
// today's AuthProvider; we'd need a SPA-side seam (a deferred
// auth-context init or a synthetic "auth ready" event) to make this race
// observably reachable. Marked .fixme until that seam exists; the
// regression-class this guards against (no token in WS handshake) is
// already covered structurally by PR #80's bridge token fallback.
test.fixme("M10 harden: token set late races WS open", async ({ page }) => {
  test.setTimeout(180_000);

  const wsOpens: { url: string; ts: number }[] = [];
  const wsFrames: { dir: "<" | ">"; method: string; ts: number; sample: string }[] = [];
  const startedAt = Date.now();

  page.on("websocket", (ws: WebSocket) => {
    if (!ws.url().includes("/api/ui-protocol/ws")) return;
    wsOpens.push({ url: ws.url(), ts: Date.now() - startedAt });
    ws.on("framereceived", (data) => {
      const s = typeof data.payload === "string" ? data.payload : data.payload.toString("utf8");
      try {
        const j = JSON.parse(s);
        const m = j.method || (j.id ? "rpc-response" : "?");
        wsFrames.push({ dir: "<", method: m, ts: Date.now() - startedAt, sample: s.slice(0, 160) });
      } catch {}
    });
    ws.on("framesent", (data) => {
      const s = typeof data.payload === "string" ? data.payload : data.payload.toString("utf8");
      try {
        const j = JSON.parse(s);
        const m = j.method || (j.id ? "rpc-call" : "?");
        wsFrames.push({ dir: ">", method: m, ts: Date.now() - startedAt, sample: s.slice(0, 160) });
      } catch {}
    });
    ws.on("close", () => {
      wsFrames.push({ dir: "<", method: "(ws-close)", ts: Date.now() - startedAt, sample: "" });
    });
    ws.on("socketerror", (err) => {
      wsFrames.push({
        dir: "<",
        method: `(ws-error: ${String(err).slice(0, 60)})`,
        ts: Date.now() - startedAt,
        sample: "",
      });
    });
  });

  // Stage tokens via addInitScript with a setTimeout: tokens land in
  // localStorage AFTER the SPA's initial mount, racing whatever WS
  // open / bridge.getToken() the SPA tries on first hydrate.
  await page.addInitScript(
    ({ token, profile, delayMs }) => {
      // The chat-app feature flag and profile are NOT delayed — those
      // are read by the router before the WS bridge mounts, and
      // delaying them would prevent /chat from rendering at all
      // (defeats the purpose). Only the auth token is delayed.
      localStorage.setItem("selected_profile", profile);
      localStorage.setItem("chat_app_ui_v1", "1");
      localStorage.setItem("octos_thread_store_v2", "1");
      setTimeout(() => {
        localStorage.setItem("octos_session_token", token);
        localStorage.setItem("octos_auth_token", token);
        // Synthetic event for any code that listens for storage events.
        window.dispatchEvent(new StorageEvent("storage", { key: "octos_auth_token" }));
      }, delayMs);
    },
    { token: TOKEN, profile: PROFILE, delayMs: TOKEN_DELAY_MS },
  );

  await page.goto(`${BASE_URL}/chat`, { waitUntil: "domcontentloaded" });

  // Wait for chat-input. If the auth guard redirected us to /login
  // because the token wasn't there at mount, this will time out — that
  // is itself the bug we're probing for.
  let chatVisible = false;
  let landingUrl = "";
  try {
    await page.waitForSelector("[data-testid='chat-input']", { timeout: 25_000 });
    chatVisible = true;
  } catch {
    landingUrl = page.url();
  }

  console.log(`--- chatVisible=${chatVisible} landingUrl=${landingUrl} ---`);
  console.log(
    `--- wsOpens (${wsOpens.length}): ${JSON.stringify(wsOpens).slice(0, 200)} ---`,
  );
  console.log(`--- frames (${wsFrames.length}) first 30 ---`);
  for (const f of wsFrames.slice(0, 30)) {
    console.log(`  ${f.dir} ${f.method} @${f.ts}ms`);
  }

  expect(
    chatVisible,
    `OTP race: chat-input never appeared (delay=${TOKEN_DELAY_MS}ms). URL=${landingUrl}`,
  ).toBe(true);

  // Codex feedback: the absolute 200ms delay starts at addInitScript time,
  // BEFORE the SPA's module bundle loads. On slow live deploys the bundle
  // can take >200ms to evaluate, so the token is already in localStorage by
  // the time the bridge first reads it — the race never actually happens
  // and the test false-passes. To prove the race fired, assert that the
  // FIRST WS open attempt had no `token=` query param. The bridge fallback
  // (PR #80) reads localStorage directly on every reconnect attempt, so
  // a subsequent reconnect picks up the late-arriving token. If there's
  // only one open and it had a token, we never exercised the race.
  const firstOpen = wsOpens[0];
  expect(firstOpen, "no WS open attempts captured at all").toBeTruthy();
  const firstOpenWasUnauth = !!firstOpen && !/[?&]token=[^&]+/.test(firstOpen.url);
  // Console-log either way so a flake makes the false-pass visible.
  console.log(
    `--- first WS open had token? ${!firstOpenWasUnauth} (race fired: ${firstOpenWasUnauth}) ---`,
  );
  expect(
    firstOpenWasUnauth,
    "OTP race did not fire: first WS open already carried token=… in URL. " +
      "Likely the bundle loaded slower than the addInitScript delay. " +
      "Increase TOKEN_DELAY_MS or tie the delay to a SPA-side trigger.",
  ).toBe(true);

  // Send a quick prompt — verify the bridge actually established a
  // working WS by the time the chat is interactive.
  const PROMPT = "What is 1 + 1? One digit reply.";
  await page.locator("[data-testid='chat-input']").first().fill(PROMPT);
  await page.locator("[data-testid='send-button']").first().click();

  // Confirm turn/start went out and we got a server-side acknowledgment.
  let sawTurnStart = false;
  let sawServerAck = false;
  for (let i = 0; i < 60; i++) {
    if (wsFrames.some((f) => f.dir === ">" && /turn\/start/.test(f.method))) {
      sawTurnStart = true;
    }
    if (
      wsFrames.some(
        (f) =>
          f.dir === "<" &&
          /(message\/persisted|message\/delta|turn\/started|turn\/completed)/.test(
            f.method,
          ),
      )
    ) {
      sawServerAck = true;
    }
    if (sawTurnStart && sawServerAck) break;
    await page.waitForTimeout(1_000);
  }

  console.log(
    `--- final: turn/start=${sawTurnStart} server-ack=${sawServerAck} (frames=${wsFrames.length}) ---`,
  );

  expect(sawTurnStart, "no turn/start frame went out — bridge never armed").toBe(true);
  expect(sawServerAck, "no server-side ack received within 60s of turn/start").toBe(true);
});
