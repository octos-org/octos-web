/**
 * Test audio auto-play on a session that has audio files in history.
 * This is the scenario the user reports — audio plays when loading chat history.
 */

import { test, expect } from "@playwright/test";

const API_BASE = process.env.API_BASE || "https://crew.ominix.io";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";

test.setTimeout(120_000);

test("audio does NOT auto-play when loading history with audio files", async ({
  page,
}) => {
  // First, find a session that has audio files via API
  const sessResp = await fetch(`${API_BASE}/api/sessions?source=full`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  const sessions = (await sessResp.json()) as { id: string; message_count: number }[];

  // Find sessions with audio
  let audioSessionId = "";
  for (const sess of sessions.slice(0, 20)) {
    const msgResp = await fetch(
      `${API_BASE}/api/sessions/${encodeURIComponent(sess.id)}/messages?source=full&limit=50`,
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    );
    const msgs = (await msgResp.json()) as { content: string; media?: string[] }[];
    const hasAudio = msgs.some(
      (m) =>
        m.media?.some((p) => /\.(mp3|wav|ogg|m4a)$/i.test(p)) ||
        /\.(mp3|wav|ogg|m4a)/i.test(m.content),
    );
    if (hasAudio) {
      audioSessionId = sess.id;
      console.log(`  [test] Found session with audio: ${sess.id} (${sess.message_count} msgs)`);
      break;
    }
  }

  if (!audioSessionId) {
    console.log("  [test] No session with audio files found — skipping");
    return;
  }

  // Login and set session
  await page.goto(`${API_BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ token, sessionId }) => {
      localStorage.setItem("octos_session_token", token);
      localStorage.setItem("octos_auth_token", token);
      localStorage.setItem("current_session_id", sessionId);
    },
    { token: AUTH_TOKEN, sessionId: audioSessionId },
  );

  // Inject audio monitoring BEFORE page loads content
  await page.addInitScript(() => {
    const played: string[] = [];
    (window as any).__audioPlayed = played;

    // Patch HTMLAudioElement.prototype.play
    const origPlay = HTMLAudioElement.prototype.play;
    HTMLAudioElement.prototype.play = function (this: HTMLAudioElement) {
      played.push(`play:${this.src?.slice(0, 80) || "no-src"}`);
      console.warn(`[AUTOPLAY] play() called on: ${this.src?.slice(0, 80)}`);
      return origPlay.call(this);
    };

    // Listen for 'playing' event on any audio
    document.addEventListener(
      "playing",
      (e) => {
        if (e.target instanceof HTMLAudioElement) {
          played.push(`playing:${e.target.src?.slice(0, 80) || "no-src"}`);
          console.warn(`[AUTOPLAY] playing event: ${e.target.src?.slice(0, 80)}`);
        }
      },
      true,
    );
  });

  // Now reload to trigger history loading with audio files
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(15_000); // Wait for history + blob URLs to load

  // Collect results
  const audioCount = await page.locator("audio").count();
  const played = await page.evaluate(() => (window as any).__audioPlayed || []);
  const audioDetails = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("audio")).map((a) => ({
      src: a.src?.slice(0, 100) || "no-src",
      paused: a.paused,
      preload: a.preload,
      autoplay: a.autoplay,
      currentTime: a.currentTime,
      readyState: a.readyState,
    }));
  });

  console.log(`  [test] Audio elements: ${audioCount}`);
  console.log(`  [test] Play events: ${played.length}`);
  for (const p of played) {
    console.log(`  [AUTOPLAY] ${p}`);
  }
  for (const a of audioDetails) {
    console.log(
      `  [audio] paused=${a.paused} preload=${a.preload} autoplay=${a.autoplay} time=${a.currentTime} ready=${a.readyState} src=${a.src}`,
    );
  }

  // Take screenshot for evidence
  await page.screenshot({ path: "test-results/audio-autoplay-evidence.png" });

  // ASSERT
  expect(played.length).toBe(0);
  expect(audioDetails.every((a) => a.paused)).toBe(true);
  expect(audioDetails.every((a) => !a.autoplay)).toBe(true);
});
