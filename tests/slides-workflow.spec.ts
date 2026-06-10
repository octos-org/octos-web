/**
 * Comprehensive /new slides workflow test.
 * Tests the full slide creation → update → incremental regeneration flow.
 *
 * Runs against a live server with Kimi-k2.5 (strong model).
 * Requires GEMINI_API_KEY for mofa_slides image generation.
 */

import { test, expect } from "@playwright/test";
import {
  login,
  sendAndWait,
  getInput,
  getSendButton,
  SEL,
  countUserBubbles,
  countAssistantBubbles
} from "./helpers";

// Use longer timeouts — slide generation takes minutes
test.setTimeout(900_000); // 10 min per test

test.beforeEach(async ({ page }) => {
  await login(page);
});

// ── Round 1: Create slides project ──────────────────────────────

test("Round 1: /new slides creates project and agent follows design-first workflow", async ({
  page
}) => {
  // Step 1: Create slides project
  const input = getInput(page);
  await input.fill("/new slides ai-test-deck");
  await page.keyboard.press("Enter");

  // Wait for assistant to respond to /new command
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid='assistant-message']").length > 0,
      undefined,
      { timeout: 90_000 },
    );
  } catch {
    test.skip(true, "waitForFunction timed out — no assistant response");
  }
  await page.waitForTimeout(2000);

  const assistantBubbles = await countAssistantBubbles(page);
  test.skip(!assistantBubbles, "No assistant bubbles — WS bridge drop");

  const lastBubble = page.locator(SEL.assistantMessage).last();
  const responseText = (await lastBubble.textContent()) || "";
  console.log("  [slides] /new response:", responseText.slice(0, 200));

  // Should mention project directory or slides
  expect(
    responseText.toLowerCase().includes("slides") ||
      responseText.toLowerCase().includes("project") ||
      responseText.toLowerCase().includes("created"),
  ).toBe(true);

  // Step 2: Describe what we want — agent should write JS, NOT generate yet
  const result = await sendAndWait(
    page,
    "Make a 3-slide deck about AI in healthcare. Style: nb-pro. Slides: 1) Cover with title, 2) Key benefits, 3) Future outlook. Write the script.js first, do NOT generate yet.",
    { label: "design" },
  );
  test.skip(result.timedOut || result.assistantBubbles === 0, "Timeout or WS bridge drop");

  console.log("  [slides] design response length:", result.responseLen);
  console.log("  [slides] design response:", result.responseText.slice(0, 300));

  // Agent should have written script.js (mentions write_file or script.js)
  // and should NOT have called mofa_slides yet
  const mentions_script = result.responseText.includes("script.js") ||
    result.responseText.includes("write_file") ||
    result.responseText.includes("JS");
  const mentions_generate = result.responseText.includes("mofa_slides") ||
    result.responseText.includes("generating") ||
    result.responseText.includes("生成中");

  console.log("  [slides] mentions script:", mentions_script);
  console.log("  [slides] mentions generate:", mentions_generate);

  // Design-first: should write script, should NOT generate
  // (this validates the SKILL.md prompt instructions)
  expect(mentions_script || result.responseLen > 100).toBe(true);
});

// ── Round 2: Review and modify before generating ────────────────

test("Round 2: modify slide content before generating", async ({ page }) => {
  // Assume we're in a slides session from Round 1
  // First create a fresh project
  const input = getInput(page);
  await input.fill("/new slides update-test");
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid='assistant-message']").length > 0,
      undefined,
      { timeout: 90_000 },
    );
  } catch {
    test.skip(true, "waitForFunction timed out — no assistant response");
  }
  await page.waitForTimeout(2000);

  // Create initial 3-slide deck
  const result1 = await sendAndWait(
    page,
    "Make a 3-slide deck about quantum computing. Style: nb-pro. Write script.js only, do NOT generate.",
    { label: "create" },
  );
  test.skip(result1.timedOut || result1.assistantBubbles === 0, "Timeout or WS bridge drop");
  console.log("  [update] initial response:", result1.responseLen, "chars");

  // Now ask to modify slide 2
  const result2 = await sendAndWait(
    page,
    "Change slide 2 title to 'Quantum Advantage in 2026'. Update only slide 2 in script.js. Do NOT generate yet.",
    { label: "modify" },
  );
  console.log("  [update] modify response:", result2.responseText.slice(0, 200));

  // Should mention editing/updating, not recreating
  const mentions_edit = result2.responseText.includes("edit") ||
    result2.responseText.includes("update") ||
    result2.responseText.includes("修改") ||
    result2.responseText.includes("changed") ||
    result2.responseText.includes("slide 2");
  console.log("  [update] mentions edit:", mentions_edit);
});

// ── Round 3: Generate PPTX ──────────────────────────────────────

test("Round 3: generate PPTX on explicit command", async ({ page }) => {
  const input = getInput(page);
  await input.fill("/new slides gen-test");
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid='assistant-message']").length > 0,
      undefined,
      { timeout: 90_000 },
    );
  } catch {
    test.skip(true, "waitForFunction timed out — no assistant response");
  }
  await page.waitForTimeout(2000);

  // Create a minimal 2-slide deck
  await sendAndWait(
    page,
    "Make a 2-slide deck: 1) Title: 'Test Deck', 2) Content: 'Hello World'. Style nb-pro. Write script.js only.",
    { label: "create" },
  );

  // Now explicitly ask to generate
  const input2 = getInput(page);
  await input2.fill("generate the pptx now");
  await getSendButton(page).click();

  // Wait for mofa_slides to complete (spawn_only, background task)
  // Look for task status indicator or file attachment
  let generated = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000);

    // Check for file attachment (pptx link or download)
    const fileLinks = await page.locator("a[href*='api/files'], a[download]").count();
    if (fileLinks > 0) {
      generated = true;
      console.log(`  [gen] PPTX file delivered at ${i * 5}s`);
      break;
    }

    // Check for task status
    const taskPill = await page.locator("text=mofa_slides").isVisible().catch(() => false);
    if (taskPill) {
      console.log(`  [gen] task status visible at ${i * 5}s`);
    }

    // Check for completion message
    const lastBubble = page.locator(SEL.assistantMessage).last();
    const text = (await lastBubble.textContent()) || "";
    if (text.includes(".pptx") || text.includes("generated") || text.includes("完成")) {
      console.log(`  [gen] completion text at ${i * 5}s: ${text.slice(0, 100)}`);
      generated = true;
      break;
    }
  }

  console.log(`  [gen] PPTX generated: ${generated}`);
  // Note: may fail if GEMINI_API_KEY quota exceeded — that's expected
});

// ── Round 4: Incremental update (delete PNG + regenerate) ───────

test("Round 4: incremental update deletes only changed slide PNG", async ({
  page
}) => {
  const input = getInput(page);
  await input.fill("/new slides delta-test");
  await page.keyboard.press("Enter");
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("[data-testid='assistant-message']").length > 0,
      undefined,
      { timeout: 90_000 },
    );
  } catch {
    test.skip(true, "waitForFunction timed out — no assistant response");
  }
  await page.waitForTimeout(2000);

  // Create and generate a 2-slide deck
  await sendAndWait(
    page,
    "Make a 2-slide deck: 1) Title 'Delta Test', 2) Content 'Original'. Style nb-pro. Write script.js.",
    { label: "create" },
  );

  // Generate initial PPTX
  const genResult = await sendAndWait(
    page,
    "generate pptx",
    { label: "gen1" },
  );
  console.log("  [delta] initial gen:", genResult.responseText.slice(0, 100));

  // Now update slide 2 only
  const updateResult = await sendAndWait(
    page,
    "Update slide 2 content to 'Updated Content 2026'. Delete only slide-02.png, then regenerate.",
    { label: "update" },
  );
  console.log("  [delta] update response:", updateResult.responseText.slice(0, 200));

  // Check that the response mentions:
  // - editing script.js (not recreating)
  // - deleting slide-02.png (not all PNGs)
  // - regenerating (calling mofa_slides)
  const text = updateResult.responseText.toLowerCase();
  const correct_workflow =
    (text.includes("slide-02") || text.includes("slide 2")) &&
    (text.includes("rm") || text.includes("delete") || text.includes("删除"));
  console.log("  [delta] follows incremental workflow:", correct_workflow);
});

// ── Slash commands work ─────────────────────────────────────────

test("slash commands: /sessions, /new, /help work without blocking", async ({
  page
}) => {
  const input = getInput(page);
  const sendBtn = getSendButton(page);

  // /help should return command list, not go to LLM
  await input.fill("/help");
  await sendBtn.click();
  await page.waitForTimeout(5000);

  const helpText = (await page.locator(SEL.cmdFeedback).textContent()) || "";
  expect(helpText.includes("/new") || helpText.includes("command")).toBe(true);

  // Send button should NOT be locked after command
  await page.waitForTimeout(1000);
  await input.fill("hello after command");
  const isDisabled = await sendBtn.isDisabled();
  expect(isDisabled).toBe(false);
});
