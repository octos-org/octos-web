/**
 * Test audio auto-play on a session that has audio files in history.
 * This is the scenario the user reports — audio plays when loading chat history.
 */

import { test, expect } from "@playwright/test";

const API_BASE = process.env.BASE_URL || process.env.API_BASE || "https://crew.ominix.io";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";

test.setTimeout(120_000);

test("audio does NOT auto-play when loading history with audio files", async ({
  page,
}) => {
  let sessResp: Response;
  try {
    sessResp = await fetch(`${API_BASE}/api/sessions?source=full`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
  } catch {
    test.skip(true, "/api/sessions endpoint unreachable");
    return;
  }
  if (!sessResp.ok) {
    test.skip(true, "/api/sessions endpoint not available (got " + sessResp.status + ")");
    return;
  }
  const sessions = (await sessResp.json()) as { id: string; message_count: number }[];

  let audioSessionId = "";
  for (const sess of sessions.slice(0, 20)) {
    const msgResp = await fetch(
      `${API_BASE}/api/sessions/${encodeURIComponent(sess.id)}/messages?source=full&limit=50`,
      { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    );
    if (!msgResp.ok) continue;
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
    test.skip(true, "No session with audio files found");
    return;
  }

  await page.goto(`${API_BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ token, sessionId }) => {
      localStorage.setItem("octos_session_token", token);
      localStorage.setItem("octos_auth_token", token);
      localStorage.setItem("current_session_id", sessionId);
    },
    { token: AUTH_TOKEN, sessionId: audioSessionId },
  );

  await page.addInitScript(() => {
    const played: string[] = [];
    (window as any).__audioPlayed = played;
    const origPlay = HTMLAudioElement.prototype.play;
    HTMLAudioElement.prototype.play = function (this: HTMLAudioElement) {
      played.push(`play:${this.src?.slice(0, 80) || "no-src"}`);
      return origPlay.call(this);
    };
    document.addEventListener(
      "playing",
      (e) => {
        if (e.target instanceof HTMLAudioElement) {
          played.push(`playing:${e.target.src?.slice(0, 80) || "no-src"}`);
        }
      },
      true,
    );
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(15_000);

  const played = await page.evaluate(() => (window as any).__audioPlayed || []);
  const audioDetails = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("audio")).map((a) => ({
      src: a.src?.slice(0, 100) || "no-src",
      paused: a.paused,
      autoplay: a.autoplay,
    }));
  });

  console.log(`  [test] Play events: ${played.length}`);
  expect(played.length).toBe(0);
  expect(audioDetails.every((a) => a.paused)).toBe(true);
  expect(audioDetails.every((a) => !a.autoplay)).toBe(true);
});
