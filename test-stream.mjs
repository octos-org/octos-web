/**
 * Focused test: single deep search to verify intermediate streaming.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5174";
const AUTH_TOKEN = "crew2026";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext().then((c) => c.newPage());

  // Track SSE events
  const sseEvents = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("[adapter] SSE event:")) {
      const ts = ((Date.now() - startTime) / 1000).toFixed(1);
      sseEvents.push(`${ts}s: ${text}`);
      console.log(`  ${ts}s SSE: ${text}`);
    }
  });

  const startTime = Date.now();

  try {
    // Login
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "Auth Token" }).click();
    await page.locator('input[type="password"]').fill(AUTH_TOKEN);
    await page.locator("button", { hasText: "Login" }).click();
    await page.waitForURL(`${BASE}/`, { timeout: 15000 });
    await page.waitForSelector("textarea", { timeout: 10000 });
    console.log("Logged in\n");

    const input = page.locator("textarea").first();
    const sendBtn = page.locator("button").filter({ has: page.locator("svg") }).last();

    // Send deep search
    console.log("=== Sending deep search ===");
    await input.fill(
      "Do a deep search on the latest AI agent frameworks in 2026. Compare the top 3."
    );
    await sendBtn.click();

    // Poll for 5 minutes, checking response length
    const start = Date.now();
    let lastLen = 0;
    while (Date.now() - start < 300000) {
      await page.waitForTimeout(5000);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);

      const asstBubbles = await page.locator(".bg-surface-light.rounded-2xl").all();
      let currentLen = 0;
      if (asstBubbles.length > 0) {
        const text = await asstBubbles[asstBubbles.length - 1].textContent();
        currentLen = text?.trim().length || 0;
      }

      const stopBtn = page.locator("button.bg-red-600");
      const streaming = await stopBtn.isVisible().catch(() => false);

      if (currentLen !== lastLen) {
        console.log(`  ${elapsed}s: response=${currentLen} chars (was ${lastLen}), streaming=${streaming}`);
        lastLen = currentLen;
      } else {
        console.log(`  ${elapsed}s: response=${currentLen} chars, streaming=${streaming}`);
      }

      // Done if not streaming and has content
      if (!streaming && currentLen > 0) {
        console.log(`\n=== Done at ${elapsed}s ===`);
        break;
      }
    }

    // Final snapshot
    const asstBubbles = await page.locator(".bg-surface-light.rounded-2xl").all();
    if (asstBubbles.length > 0) {
      const text = await asstBubbles[asstBubbles.length - 1].textContent();
      const trimmed = text?.trim() || "";
      console.log(`\nFinal response (${trimmed.length} chars):`);
      console.log(trimmed.slice(0, 500));
      console.log(trimmed.length > 500 ? "...\n" : "\n");
    }

    console.log(`\n=== SSE Events (${sseEvents.length} total) ===`);
    for (const e of sseEvents) console.log(`  ${e}`);

    await page.screenshot({ path: "/tmp/octos-stream-test.png", fullPage: true });

  } catch (err) {
    console.error("FAILED:", err.message);
    await page.screenshot({ path: "/tmp/octos-stream-error.png", fullPage: true });
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
