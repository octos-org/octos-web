import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "https://dspfac.crew.ominix.io";
const TOKEN = process.env.OCTOS_AUTH_TOKEN ?? "octos-admin-2026";

// Live probe: requires an opt-in env var so a default `npm test` /
// `npx playwright test` invocation does not silently mutate the
// production deployment. Run with:
//   OCTOS_LIVE_PROBE=1 BASE_URL=... OCTOS_AUTH_TOKEN=... \
//     npx playwright test tests/probe-bug-c-web-hydrate.spec.ts
test.skip(
  !process.env.OCTOS_LIVE_PROBE,
  "set OCTOS_LIVE_PROBE=1 to run the live hydrate probe (M10 Bug C)",
);

/**
 * Bug C — page-reload hydrate emits N+1 rows
 *
 * Server PR #791 (M10 Phase 6.2-orig) extended `session/hydrate` with
 * `replayed_envelopes` + per-row `(message_id, source)` so negotiated
 * clients can dedup the legacy `Background`-source rows the live wire
 * suppresses. This SPA-side companion PR consumes those fields.
 *
 * Pass criterion: post-reload bubble count exactly equals pre-reload
 * bubble count (NOT an inequality — we want bit-for-bit DOM parity
 * after refresh for any session that contains a spawn_only completion).
 */
test("bug-c: hydrate after refresh does not inflate bubble count (web-side dedup)", async ({
  page,
}) => {
  test.setTimeout(420_000);

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 250));
  });

  await page.addInitScript(
    ({ token }) => {
      localStorage.setItem("octos_session_token", token);
      localStorage.setItem("octos_auth_token", token);
      localStorage.setItem("selected_profile", "dspfac");
      localStorage.setItem("chat_app_ui_v1", "1");
      localStorage.setItem("octos_thread_store_v2", "1");
    },
    { token: TOKEN },
  );

  await page.goto(`${BASE_URL}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid='chat-input']", { timeout: 30_000 });
  // Force a fresh chat so we have a clean slate.
  await page
    .locator("[data-testid='new-chat-button']")
    .click()
    .catch(() => {});
  await page.waitForTimeout(800);

  // Trigger a deep_research turn — spawns a `spawn_only` task whose
  // background-source rows + `turn/spawn_complete` envelope land in
  // the ledger. Pre-fix, the reload re-rendered all background rows.
  await page
    .locator("[data-testid='chat-input']")
    .first()
    .fill(
      "Use deep_research to write a short note on the 2027 FIBA Cup. Keep it under 150 words.",
    );
  await page.locator("[data-testid='send-button']").first().click();

  // Wait for the spawn_only completion to land — watch for a bubble
  // that contains the report content or the file attachment marker.
  const completionDeadline = Date.now() + 240_000;
  while (Date.now() < completionDeadline) {
    const completionVisible = await page
      .locator("[data-testid='assistant-message']")
      .filter({ hasText: /report|delivered|completed|FIBA|2027/i })
      .count();
    if (completionVisible >= 1) break;
    await page.waitForTimeout(2_000);
  }

  // Capture the live session id so we can navigate back to it.
  const liveSessionId = await page.evaluate(() =>
    localStorage.getItem("octos_current_session"),
  );
  console.log(`--- live session id: ${liveSessionId} ---`);

  // Pre-reload DOM snapshot.
  const liveBubbles = await page.evaluate(() => {
    const nodes = document.querySelectorAll(
      "[data-testid='user-message'], [data-testid='assistant-message']",
    );
    return Array.from(nodes).map((el) => ({
      role: el.getAttribute("data-testid"),
      text: (el.textContent || "").trim().slice(0, 200),
    }));
  });
  console.log(`--- live bubbles (${liveBubbles.length}) ---`);
  for (const b of liveBubbles) console.log(`  ${b.role}: ${b.text.slice(0, 120)}`);

  // Hard refresh — this is the path that exercises the WS hydrate
  // dedup pass (bridge issues `session/hydrate`, the result is fed
  // into `applyHydrateDedup` against the REST `replayHistory` state).
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid='chat-input']", { timeout: 30_000 });
  if (liveSessionId) {
    await page.evaluate((sid) => {
      localStorage.setItem("octos_current_session", sid);
    }, liveSessionId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid='chat-input']", {
      timeout: 30_000,
    });
  }
  // Allow REST hydrate + WS hydrate dedup to settle. The chat-thread
  // mount fires forced retries at 2s/5s/12s; wait past the last one
  // so the dedup pass has stabilised.
  await page.waitForTimeout(15_000);

  const reloadBubbles = await page.evaluate(() => {
    const nodes = document.querySelectorAll(
      "[data-testid='user-message'], [data-testid='assistant-message']",
    );
    return Array.from(nodes).map((el) => ({
      role: el.getAttribute("data-testid"),
      text: (el.textContent || "").trim().slice(0, 200),
    }));
  });
  console.log(`--- reload bubbles (${reloadBubbles.length}) ---`);
  for (const b of reloadBubbles) console.log(`  ${b.role}: ${b.text.slice(0, 120)}`);
  console.log("--- console errors ---");
  for (const e of consoleErrors.slice(0, 10)) console.log(" ", e);

  // Pass criterion: post-refresh DOM has the SAME bubble count as
  // pre-refresh. Pre-fix: reload count was live+N (per-file companion
  // rows were re-rendered alongside the spawn_complete envelope).
  expect(reloadBubbles.length).toBe(liveBubbles.length);

  // Sanity: at least one user + one assistant bubble.
  expect(
    liveBubbles.filter((b) => b.role === "user-message").length,
  ).toBeGreaterThanOrEqual(1);
  expect(
    liveBubbles.filter((b) => b.role === "assistant-message").length,
  ).toBeGreaterThanOrEqual(1);
});
