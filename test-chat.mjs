/**
 * Automated headless browser test for octos-web chat.
 * 10-round long chat with deep search, /queue collect, and multi-turn history.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:5174";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "crew2026";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const logs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    logs.push(`[${msg.type()}] ${text}`);
    if (
      text.startsWith("[adapter]") ||
      text.startsWith("[runtime]") ||
      text.startsWith("[session]")
    ) {
      console.log(`  BROWSER: ${text}`);
    }
  });
  page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));

  try {
    // === Login ===
    console.log("=== Login ===");
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "Auth Token" }).click();
    await page.locator('input[type="password"]').fill(AUTH_TOKEN);
    await page.locator("button", { hasText: "Login" }).click();
    await page.waitForURL(`${BASE}/`, { timeout: 15000 });
    await page.waitForSelector(
      "textarea, [role='textbox'], input[placeholder]",
      { timeout: 10000 },
    );
    console.log("  Logged in\n");

    const input = page
      .locator("textarea, [role='textbox'], input[placeholder*='message']")
      .first();
    const sendBtn = page
      .locator("button")
      .filter({ has: page.locator("svg") })
      .last();

    // Helper: send message and wait for streaming to complete
    async function sendAndWait(msg, label, maxWait = 120000) {
      console.log(`\n=== Round ${label}: Sending ===`);
      console.log(`  "${msg.slice(0, 100)}${msg.length > 100 ? "..." : ""}"`);

      await input.fill(msg);
      await sendBtn.click();

      const start = Date.now();
      let lastBubbleCount = 0;
      let stableCount = 0;

      while (Date.now() - start < maxWait) {
        await page.waitForTimeout(3000);

        const stopBtn = page.locator("button.bg-red-600");
        const isStreaming = await stopBtn.isVisible().catch(() => false);

        const bubbles = await page.locator(".rounded-2xl").all();
        const currentCount = bubbles.length;

        if (currentCount === lastBubbleCount && !isStreaming) {
          stableCount++;
          if (stableCount >= 2) break;
        } else {
          stableCount = 0;
        }
        lastBubbleCount = currentCount;

        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(
          `  ${elapsed}s: ${currentCount} bubbles, streaming=${isStreaming}`,
        );
      }

      const bubbles = await page.locator(".rounded-2xl").all();
      const assistantBubbles = await page
        .locator(".bg-surface-light.rounded-2xl")
        .all();
      const lastText =
        assistantBubbles.length > 0
          ? await assistantBubbles[assistantBubbles.length - 1].textContent()
          : "";
      const trimmed = lastText?.trim() || "";
      console.log(`  Done: ${bubbles.length} total bubbles`);
      console.log(
        `  Response (${trimmed.length} chars): "${trimmed.slice(0, 200)}${trimmed.length > 200 ? "..." : ""}"`,
      );

      await page.screenshot({
        path: `/tmp/octos-test-r${label}.png`,
        fullPage: true,
      });

      return { totalBubbles: bubbles.length, responseLen: trimmed.length };
    }

    // =====================================================
    // 10-round conversation
    // =====================================================

    // Round 1: Set queue collect mode
    await sendAndWait("/queue collect", "01-queue-collect", 30000);

    // Round 2: Deep search request
    await sendAndWait(
      "Do a deep search on the latest developments in autonomous AI agents in 2026. Focus on enterprise adoption, open-source frameworks, and safety regulations.",
      "02-deep-search",
      180000,
    );

    // Round 3: Follow-up on search results
    await sendAndWait(
      "Based on those search results, which open-source AI agent frameworks are most popular right now? Compare at least 3 of them.",
      "03-followup-frameworks",
      120000,
    );

    // Round 4: Technical deep dive
    await sendAndWait(
      "Explain in detail how a modern AI agent orchestration system works. Cover the message loop, tool execution, context management, and memory systems. Be very thorough - I want at least 1000 words.",
      "04-agent-architecture",
      120000,
    );

    // Round 5: Another search
    await sendAndWait(
      "Search the web for recent breakthroughs in LLM reasoning capabilities. What new techniques have emerged in 2025-2026?",
      "05-search-reasoning",
      180000,
    );

    // Round 6: Context reference back
    await sendAndWait(
      "Going back to the agent orchestration you described in round 4, how would the new reasoning techniques from your latest search improve agent performance? Connect the two topics.",
      "06-cross-reference",
      120000,
    );

    // Round 7: Code generation request
    await sendAndWait(
      "Write a Python implementation of a simple AI agent loop with tool execution. Include: message history management, tool registry, LLM call with streaming, and error recovery. Add detailed comments.",
      "07-code-generation",
      120000,
    );

    // Round 8: Deep search on different topic
    await sendAndWait(
      "Do a deep search on WebSocket vs Server-Sent Events for real-time AI streaming applications. What are the latest best practices in 2026?",
      "08-search-streaming",
      180000,
    );

    // Round 9: Synthesize everything
    await sendAndWait(
      "Now synthesize everything we've discussed: AI agents, reasoning techniques, the Python agent loop code, and streaming protocols. Write a comprehensive architecture proposal for building a production AI agent platform. Reference our earlier discussion points.",
      "09-synthesis",
      120000,
    );

    // Round 10: Final wrap-up
    await sendAndWait(
      "Summarize our entire conversation in bullet points. List each topic we covered and the key takeaway from each round. This tests that you have full context of all 10 rounds.",
      "10-summary",
      120000,
    );

    // =====================================================
    // Final verification
    // =====================================================
    console.log("\n=== Final Verification ===");
    const finalBubbles = await page.locator(".rounded-2xl").all();
    const userBubbles = await page
      .locator(".bg-accent\\/20.rounded-2xl")
      .all();
    const asstBubbles = await page
      .locator(".bg-surface-light.rounded-2xl")
      .all();

    console.log(`  Total bubbles: ${finalBubbles.length}`);
    console.log(`  Expected: 20 (10 user + 10 assistant)`);
    console.log(`  User bubbles: ${userBubbles.length}`);
    console.log(`  Assistant bubbles: ${asstBubbles.length}`);

    for (let i = 0; i < asstBubbles.length; i++) {
      const text = await asstBubbles[i].textContent();
      const len = text?.trim().length || 0;
      console.log(
        `  Asst ${i + 1}: ${len} chars - "${(text?.trim() || "").slice(0, 100)}${len > 100 ? "..." : ""}"`,
      );
    }

    for (let i = 0; i < userBubbles.length; i++) {
      const text = await userBubbles[i].textContent();
      console.log(
        `  User ${i + 1}: "${(text?.trim() || "").slice(0, 80)}..."`,
      );
    }

    await page.screenshot({
      path: "/tmp/octos-test-final.png",
      fullPage: true,
    });

    // Verdict
    console.log("\n=== Verdict ===");
    const expectedBubbles = 20;
    if (finalBubbles.length >= expectedBubbles) {
      console.log(
        `  BUBBLES: PASS (${finalBubbles.length} >= ${expectedBubbles})`,
      );
    } else {
      console.log(
        `  BUBBLES: FAIL (${finalBubbles.length} < ${expectedBubbles})`,
      );
    }

    let allHaveContent = true;
    let totalResponseChars = 0;
    for (const b of asstBubbles) {
      const t = await b.textContent();
      const len = t?.trim().length || 0;
      totalResponseChars += len;
      if (len < 10) allHaveContent = false;
    }
    console.log(
      `  CONTENT: ${allHaveContent ? "PASS" : "FAIL"} (total ${totalResponseChars} chars across ${asstBubbles.length} responses)`,
    );

    // Check for errors
    const errors = logs.filter(
      (l) =>
        (l.includes("error") || l.includes("Error")) &&
        !l.includes("refreshSessions"),
    );
    if (errors.length > 0) {
      console.log(`\n=== Errors (${errors.length}) ===`);
      for (const e of errors.slice(0, 30)) console.log(`  ${e}`);
    }
  } catch (err) {
    console.error("TEST FAILED:", err.message);
    await page.screenshot({
      path: "/tmp/octos-test-error.png",
      fullPage: true,
    });
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
