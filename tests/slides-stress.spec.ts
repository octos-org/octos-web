/**
 * Multi-round slides iteration stress test.
 * Tests whether the LLM strictly follows incremental update rules across 5 rounds.
 * Each round makes increasingly complex edits and checks compliance.
 *
 * Uses kimi-k2.5 on mini 3.
 */

import { test, expect } from "@playwright/test";

const API_BASE = process.env.API_BASE || "http://69.194.3.203:3000";
const PROFILE_ID = process.env.PROFILE_ID || "dspfac";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "e2e-test-2026";

test.setTimeout(1800_000); // 30 min — multiple LLM rounds

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

async function chat(
  message: string,
  sessionId: string,
  maxWait = 180_000,
): Promise<{ events: SseEvent[]; content: string; tools: string[] }> {
  const resp = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "X-Profile-Id": PROFILE_ID,
    },
    body: JSON.stringify({ message, session_id: sessionId, stream: true }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { events: [], content: body || `(HTTP ${resp.status})`, tools: [] };
  }
  if (!resp.body) return { events: [], content: "", tools: [] };

  const events: SseEvent[] = [];
  const tools: string[] = [];
  let content = "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const start = Date.now();

  try {
    while (Date.now() - start < maxWait) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const event: SseEvent = JSON.parse(data);
          events.push(event);
          if (event.type === "tool_start") tools.push(event.tool as string);
          if (event.type === "replace") content = event.text as string;
          if (event.type === "done") {
            if (event.content) content = event.content as string;
            return { events, content, tools };
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { events, content, tools };
}

test("5-round slides iteration stress test", async () => {
  const sessionId = `stress-${Date.now()}`;
  const results: { round: string; pass: boolean; reason: string }[] = [];

  // ── Setup: create project ──
  console.log("\n=== SETUP: /new slides stress-deck ===");
  await chat("/new slides stress-deck", sessionId, 10_000);

  // ── Round 1: Initial 5-slide deck ──
  console.log("\n=== ROUND 1: Create 5-slide deck ===");
  const r1 = await chat(
    `Create a 5-slide deck about "The Future of Space Exploration".
Style: nb-pro.
Slides:
1) Cover: "Space 2030" with subtitle "Humanity's Next Giant Leap"
2) Mars colonization timeline
3) Private vs government space programs comparison
4) Space economy projections ($1T by 2040)
5) Closing: "Ad Astra" call to action

Write script.js with full prompts and texts. Do NOT generate yet. Show me the slide plan.`,
    sessionId,
    180_000,
  );
  console.log(`  R1 response: ${r1.content.length} chars`);
  console.log(`  R1 tools: ${r1.tools.join(", ") || "none"}`);
  const r1_wrote = r1.tools.includes("write_file");
  const r1_no_gen = !r1.tools.includes("mofa_slides");
  results.push({
    round: "R1: Create 5 slides",
    pass: r1_no_gen,
    reason: r1_wrote
      ? "wrote script.js, did NOT generate"
      : r1_no_gen
        ? "showed plan, did NOT generate"
        : "FAILED: called mofa_slides prematurely",
  });

  // ── Round 2: Modify slides 2 and 4 simultaneously ──
  console.log("\n=== ROUND 2: Modify slides 2 AND 4 ===");
  const r2 = await chat(
    `Update two slides:
- Slide 2: Change title to "Mars by 2028: The Accelerated Timeline" and add a bullet about SpaceX Starship
- Slide 4: Change the projection from $1T to $3T and add "including space mining"

Only modify slides 2 and 4 in script.js. Do NOT touch slides 1, 3, 5. Do NOT generate.`,
    sessionId,
    120_000,
  );
  console.log(`  R2 tools: ${r2.tools.join(", ") || "none"}`);
  const r2_used_read = r2.tools.includes("read_file");
  const r2_used_write = r2.tools.includes("write_file");
  const r2_no_gen = !r2.tools.includes("mofa_slides");
  results.push({
    round: "R2: Modify slides 2+4",
    pass: r2_no_gen && (r2_used_read || r2_used_write),
    reason: `read=${r2_used_read} write=${r2_used_write} gen=${!r2_no_gen}`,
  });

  // ── Round 3: Generate PPTX ──
  console.log("\n=== ROUND 3: Generate PPTX ===");
  const r3 = await chat("Generate the PPTX now.", sessionId, 300_000);
  console.log(`  R3 tools: ${r3.tools.join(", ") || "none"}`);
  console.log(`  R3 response: ${r3.content.slice(0, 150)}`);
  const r3_generated = r3.tools.includes("mofa_slides");
  results.push({
    round: "R3: Generate PPTX",
    pass: r3_generated,
    reason: r3_generated
      ? `mofa_slides called, tools: ${r3.tools.join(",")}`
      : "FAILED: did not call mofa_slides",
  });

  // ── Round 4: Change ONLY slide 3, verify incremental ──
  console.log("\n=== ROUND 4: Incremental update slide 3 only ===");
  const r4 = await chat(
    `Update slide 3 only: Change the comparison to include Blue Origin and add a row for Rocket Lab.
Follow the incremental update workflow:
1. Read script.js
2. Modify ONLY slide 3
3. Delete slide-03.png from the slide dir
4. Regenerate

Do NOT modify any other slides.`,
    sessionId,
    300_000,
  );
  console.log(`  R4 tools: ${r4.tools.join(", ") || "none"}`);
  console.log(`  R4 response: ${r4.content.slice(0, 200)}`);
  const r4_read = r4.tools.includes("read_file");
  const r4_write = r4.tools.includes("write_file") || r4.tools.includes("edit_file");
  const r4_shell = r4.tools.includes("shell");
  const r4_gen = r4.tools.includes("mofa_slides");
  const r4_deleted_png = r4_shell || r4.content.includes("slide-03") || r4.content.includes("rm") || r4.content.includes("delet");
  results.push({
    round: "R4: Incremental update slide 3",
    pass: r4_read && r4_write && r4_gen,
    reason: `read=${r4_read} write=${r4_write} shell(rm)=${r4_shell} deleted_png=${r4_deleted_png} gen=${r4_gen}`,
  });

  // ── Round 5: Add a NEW slide 6 without touching existing slides ──
  console.log("\n=== ROUND 5: Add slide 6, keep 1-5 unchanged ===");
  const r5 = await chat(
    `Add a new slide 6: "International Cooperation: ISS Legacy and Lunar Gateway"
Keep slides 1-5 completely unchanged. Just append the new slide to script.js.
Then regenerate — only the new slide 6 should be generated, slides 1-5 should use cached PNGs.`,
    sessionId,
    300_000,
  );
  console.log(`  R5 tools: ${r5.tools.join(", ") || "none"}`);
  console.log(`  R5 response: ${r5.content.slice(0, 200)}`);
  const r5_read = r5.tools.includes("read_file");
  const r5_write = r5.tools.includes("write_file") || r5.tools.includes("edit_file");
  const r5_gen = r5.tools.includes("mofa_slides");
  results.push({
    round: "R5: Add slide 6, keep 1-5 cached",
    pass: r5_read && r5_write && r5_gen,
    reason: `read=${r5_read} write=${r5_write} gen=${r5_gen}`,
  });

  // ── Summary ──
  console.log("\n" + "=".repeat(60));
  console.log("STRESS TEST RESULTS");
  console.log("=".repeat(60));
  let passed = 0;
  for (const r of results) {
    const icon = r.pass ? "✓" : "✗";
    console.log(`  ${icon} ${r.round}: ${r.reason}`);
    if (r.pass) passed++;
  }
  console.log(`\n  ${passed}/${results.length} rounds passed`);
  console.log("=".repeat(60));

  // At least 4/5 rounds should pass (Round 4 incremental is hardest)
  expect(passed).toBeGreaterThanOrEqual(4);
});
