import { test, expect, type Page } from "@playwright/test";
import {
  login,
  sendAndWait,
  SEL,
  createNewSession,
  getInput,
  getSendButton,
} from "./helpers";

test.describe("TTS file delivery", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("TTS audio file is delivered and playable after background task completes", async ({ page }) => {
    // Capture all browser console logs
    page.on("console", (msg) => {
      console.log(`  [browser] ${msg.type()}: ${msg.text()}`);
    });

    // Capture crew:file DOM events
    const fileEvents: any[] = [];
    await page.evaluate(() => {
      (window as any).__capturedFileEvents = [];
      window.addEventListener("crew:file", (e: Event) => {
        const detail = (e as CustomEvent).detail;
        console.log("[test] crew:file event received:", JSON.stringify(detail));
        (window as any).__capturedFileEvents.push(detail);
      });
    });

    // Send TTS request
    console.log("Sending TTS request...");
    const result = await sendAndWait(page, "测试 yangmi 语音合成", {
      label: "tts-test",
      maxWait: 60_000,
    });

    console.log(`Response: "${result.responseText.slice(0, 100)}"`);
    expect(result.responseLen).toBeGreaterThan(0);

    // Wait for background task to complete (up to 60s)
    console.log("Waiting for file delivery...");
    let fileReceived = false;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(3000);

      const events = await page.evaluate(() => (window as any).__capturedFileEvents);
      console.log(`  ${i * 3}s: ${events.length} file events`);

      if (events.length > 0) {
        fileReceived = true;
        console.log("File event received:", JSON.stringify(events[0]));
        break;
      }

      // Also check if media panel appeared
      const panelVisible = await page.locator("[data-testid='media-panel']").isVisible().catch(() => false);
      const toastVisible = await page.locator("text=Audio ready").isVisible().catch(() => false);
      console.log(`  panel=${panelVisible}, toast=${toastVisible}`);
    }

    expect(fileReceived).toBe(true);

    const uniqueFileUrls = await page.evaluate(() => {
      const events = (window as any).__capturedFileEvents || [];
      return [...new Set(events.map((event: any) => event.fileUrl))];
    });
    expect(uniqueFileUrls).toHaveLength(1);
  });

  test("regular message works without SSE being blocked by spawn_only", async ({ page }) => {
    // Send a regular (non-TTS) question
    console.log("Sending regular question...");
    const start = Date.now();
    const result = await sendAndWait(page, "What is 2+2? Answer in one word.", {
      label: "regular-test",
      maxWait: 30_000,
    });
    const elapsed = Date.now() - start;

    console.log(`Response in ${elapsed}ms: "${result.responseText.slice(0, 100)}"`);
    expect(result.responseLen).toBeGreaterThan(0);
    // Should complete quickly (< 20s), not blocked by 120s SSE grace
    expect(elapsed).toBeLessThan(20_000);
  });

  test("can send new message while TTS is generating in background", async ({ page }) => {
    console.log("Sending TTS request...");
    const input = getInput(page);
    const sendBtn = getSendButton(page);
    await input.fill("测试 yangmi 语音合成");
    await sendBtn.click();

    await page.waitForFunction(() => {
      const bubbles = Array.from(
        document.querySelectorAll("[data-testid='assistant-message']"),
      );
      return bubbles.some((node) => {
        const text = node.textContent || "";
        return /后台|背景运行|语音合成已在后台运行|TTS 任务已启动|自动发送|自动推送/u.test(text);
      });
    }, undefined, { timeout: 30_000 });

    // Immediately send a follow-up question
    console.log("Sending follow-up question...");
    const start = Date.now();
    await input.fill("1+1等于几？一个字回答");
    await sendBtn.click();

    await page.waitForFunction(() => {
      const bubbles = Array.from(
        document.querySelectorAll("[data-testid='assistant-message']"),
      );
      return bubbles.some((node) => {
        const text = (node.textContent || "").trim();
        if (!text) return false;
        if (/fm_tts|\.mp3|TTS 任务已启动|背景运行/u.test(text)) return false;
        return /(^|[^0-9])2([^0-9]|$)|二/u.test(text);
      });
    }, undefined, { timeout: 30_000 });

    const elapsed = Date.now() - start;

    const followupText = await page.evaluate(() => {
      const bubbles = Array.from(
        document.querySelectorAll("[data-testid='assistant-message']"),
      );
      const match = bubbles.find((node) => {
        const text = (node.textContent || "").trim();
        if (!text) return false;
        if (/fm_tts|\.mp3|TTS 任务已启动|背景运行/u.test(text)) return false;
        return /(^|[^0-9])2([^0-9]|$)|二/u.test(text);
      });
      return (match?.textContent || "").trim();
    });

    console.log(`Follow-up response in ${elapsed}ms: "${followupText.slice(0, 100)}"`);
    expect(followupText.length).toBeGreaterThan(0);
    expect(followupText).not.toMatch(/fm_tts|\.mp3|TTS 任务已启动|背景运行/u);
    expect(followupText).toMatch(/(^|[^0-9])2([^0-9]|$)|二/u);
    // Should NOT be blocked by the TTS background task
    expect(elapsed).toBeLessThan(30_000);
  });
});
