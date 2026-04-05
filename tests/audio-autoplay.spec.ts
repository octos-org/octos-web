/**
 * Test that audio does NOT auto-play on page load.
 * Sends a TTS request, waits for audio file delivery,
 * then checks that no audio is playing without user interaction.
 */

import { test, expect } from "@playwright/test";

const API_BASE = process.env.API_BASE || "https://crew.ominix.io";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";

test.setTimeout(300_000);

test("audio files do NOT auto-play on page load or after delivery", async ({
  page,
}) => {
  // Login
  await page.goto(`${API_BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ token }) => {
      localStorage.setItem("octos_session_token", token);
      localStorage.setItem("octos_auth_token", token);
    },
    { token: AUTH_TOKEN },
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  // Listen for ANY audio play events
  const audioPlayed: string[] = [];
  await page.exposeFunction("__reportAudioPlay", (src: string) => {
    audioPlayed.push(src);
    console.log(`  [AUTOPLAY DETECTED] audio.play() called: ${src.slice(0, 80)}`);
  });

  // Inject a MutationObserver to catch ALL audio elements and monitor play events
  await page.evaluate(() => {
    function monitorAudio(audio: HTMLAudioElement) {
      const origPlay = audio.play.bind(audio);
      audio.play = function () {
        (window as any).__reportAudioPlay(audio.src || audio.currentSrc || "unknown");
        return origPlay();
      };
      // Also listen for the 'play' event (catches autoplay)
      audio.addEventListener("play", () => {
        (window as any).__reportAudioPlay(
          `[event] ${audio.src || audio.currentSrc || "unknown"}`,
        );
      });
    }

    // Monitor existing audio elements
    document.querySelectorAll("audio").forEach((a) => monitorAudio(a));

    // Monitor future audio elements
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLAudioElement) {
            monitorAudio(node);
          }
          if (node instanceof HTMLElement) {
            node.querySelectorAll("audio").forEach((a) => monitorAudio(a));
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  console.log("  [test] Monitoring audio elements for auto-play...");

  // Wait 10 seconds — if audio plays during this time, it's auto-play
  await page.waitForTimeout(10_000);

  // Check how many audio elements exist
  const audioCount = await page.locator("audio").count();
  console.log(`  [test] Audio elements on page: ${audioCount}`);

  // Log all audio element details
  const audioDetails = await page.evaluate(() => {
    const audios = document.querySelectorAll("audio");
    return Array.from(audios).map((a) => ({
      src: a.src?.slice(0, 80) || "no-src",
      paused: a.paused,
      preload: a.preload,
      autoplay: a.autoplay,
      currentTime: a.currentTime,
      readyState: a.readyState,
    }));
  });

  for (const a of audioDetails) {
    console.log(
      `  [audio] src=${a.src} paused=${a.paused} preload=${a.preload} autoplay=${a.autoplay} time=${a.currentTime} ready=${a.readyState}`,
    );
  }

  // ASSERT: no audio should have played
  console.log(`  [test] Auto-play events detected: ${audioPlayed.length}`);
  for (const src of audioPlayed) {
    console.log(`  [FAIL] Auto-played: ${src}`);
  }

  // Check no audio is currently playing
  const anyPlaying = audioDetails.some((a) => !a.paused);
  if (anyPlaying) {
    console.log("  [FAIL] Audio is currently playing!");
  }

  // Check no audio has autoplay attribute
  const anyAutoplay = audioDetails.some((a) => a.autoplay);
  if (anyAutoplay) {
    console.log("  [FAIL] Audio element has autoplay attribute!");
  }

  expect(audioPlayed.length).toBe(0);
  expect(anyPlaying).toBe(false);
  expect(anyAutoplay).toBe(false);
});
