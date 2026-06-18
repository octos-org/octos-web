/**
 * Audio history should hydrate as a visible attachment without starting playback.
 */

import { expect, test } from "@playwright/test";
import {
  createNewSession,
  getRenderedAudioAttachments,
  login,
  sendAndWait,
  SEL,
} from "./helpers";

test.setTimeout(120_000);

test("audio does NOT auto-play when loading history with audio files", async ({
  page,
}) => {
  await login(page);
  await createNewSession(page);

  await sendAndWait(page, "请生成一段测试音频，用来验证历史记录不会自动播放。", {
    label: "audio-history",
    maxWait: 30_000,
  });

  await expect
    .poll(async () => (await getRenderedAudioAttachments(page)).length, {
      timeout: 45_000,
      message: "audio attachment should be delivered before reload",
    })
    .toBe(1);

  await page.addInitScript(() => {
    const played: string[] = [];
    (window as unknown as { __audioPlayed: string[] }).__audioPlayed = played;
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
  await page.waitForSelector(SEL.chatInput, { timeout: 15_000 });
  await expect
    .poll(async () => (await getRenderedAudioAttachments(page)).length, {
      timeout: 45_000,
      message: "audio attachment should hydrate from session history",
    })
    .toBe(1);
  await page.waitForTimeout(2_000);

  const played = await page.evaluate(
    () => (window as unknown as { __audioPlayed?: string[] }).__audioPlayed ?? [],
  );
  const audioDetails = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("audio")).map((a) => ({
      src: a.src?.slice(0, 100) || "no-src",
      paused: a.paused,
      autoplay: a.autoplay,
    }));
  });

  expect(played).toHaveLength(0);
  expect(audioDetails.every((a) => a.paused)).toBe(true);
  expect(audioDetails.every((a) => !a.autoplay)).toBe(true);
});
