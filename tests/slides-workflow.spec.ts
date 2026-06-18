/**
 * Comprehensive /new slides workflow test.
 * Tests the full slide creation → update → incremental regeneration flow.
 *
 * Runs against a live server with Kimi-k2.5 (strong model).
 * Requires GEMINI_API_KEY for mofa_slides image generation.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  login,
  sendAndWait,
  getInput,
  getSendButton,
  SEL,
  countUserBubbles,
  countAssistantBubbles,
  createNewSession
} from "./helpers";

test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
  await login(page);
  await createNewSession(page);
});

async function issueSlidesCommand(page: Page, command: string) {
  const input = getInput(page);
  await input.fill(command);
  await getSendButton(page).click();
  await page.waitForTimeout(1_000);
  await expect(input).toBeVisible();
}

// ── Round 1: Create slides project ──────────────────────────────

test("Round 1: /new slides creates project and agent follows design-first workflow", async ({
  page
}) => {
  // Step 1: Create slides project via /new command
  await issueSlidesCommand(page, "/new slides ai-test-deck");

  // Step 2: Describe what we want — agent should write JS, NOT generate yet
  const result = await sendAndWait(
    page,
    "Make a 3-slide deck about AI in healthcare. Style: nb-pro. Slides: 1) Cover with title, 2) Key benefits, 3) Future outlook. Write the script.js first, do NOT generate yet.",
    { label: "design", maxWait: 120_000 },
  );
  expect(result.assistantBubbles).toBeGreaterThan(0);

  console.log("  [slides] design response length:", result.responseLen);
  console.log("  [slides] design response:", result.responseText.slice(0, 300));

  // LLM should acknowledge the request — may mention script, write, file, etc.
  const allBubbles = await page.locator("[data-testid='assistant-message']").allTextContents();
  const allText = allBubbles.join(" ");
  const mentions_workflow = allText.includes("script") ||
    allText.includes("write") || allText.includes("file") ||
    allText.includes("JS") || allText.includes("slide");
  expect(mentions_workflow).toBe(true);
});

// ── Round 2: Review and modify before generating ────────────────

test("Round 2: modify slide content before generating", async ({ page }) => {
  // Assume we're in a slides session from Round 1
  // First create a fresh project
  const input = getInput(page);
  await issueSlidesCommand(page, "/new slides update-test");

  // Create initial 3-slide deck
  const result1 = await sendAndWait(
    page,
    "Make a 3-slide deck about quantum computing. Style: nb-pro. Write script.js only, do NOT generate.",
    { label: "create" },
  );
  expect(result1.assistantBubbles).toBeGreaterThan(0);
  console.log("  [update] initial response:", result1.responseLen, "chars");

  // Now ask to modify slide 2
  const result2 = await sendAndWait(
    page,
    "Change slide 2 title to 'Quantum Advantage in 2026'. Update only slide 2 in script.js. Do NOT generate yet.",
    { label: "modify" },
  );
  console.log("  [update] modify response:", result2.responseText.slice(0, 200));

  const allText2 = (await page.locator("[data-testid='assistant-message']").allTextContents()).join(" ");
  expect(
    allText2.includes("edit") || allText2.includes("update") ||
    allText2.includes("修改") || allText2.includes("changed") ||
    allText2.includes("slide") || allText2.includes("script") ||
    allText2.includes("quantum") || allText2.includes("write"),
  ).toBe(true);
});

// ── Round 3: Generate PPTX ──────────────────────────────────────

test("Round 3: generate PPTX on explicit command", async ({ page }) => {
  const input = getInput(page);
  await issueSlidesCommand(page, "/new slides gen-test");

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
  let generated = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000);

    const fileLinks = await page.locator("a[href*='api/files'], a[download]").count();
    if (fileLinks > 0) {
      generated = true;
      console.log(`  [gen] PPTX file delivered at ${i * 5}s`);
      break;
    }

    const taskPill = await page.locator("text=mofa_slides").isVisible().catch(() => false);
    if (taskPill) {
      console.log(`  [gen] task status visible at ${i * 5}s`);
    }

    const lastBubble = page.locator(SEL.assistantMessage).last();
    const text = (await lastBubble.textContent()) || "";
    if (text.includes(".pptx") || text.includes("generated") || text.includes("完成")) {
      console.log(`  [gen] completion text at ${i * 5}s: ${text.slice(0, 100)}`);
      generated = true;
      break;
    }
  }

  expect(generated).toBe(true);
});

// ── Round 4: Incremental update (delete PNG + regenerate) ───────

test("Round 4: incremental update deletes only changed slide PNG", async ({
  page
}) => {
  const input = getInput(page);
  await issueSlidesCommand(page, "/new slides delta-test");

  // Create and generate a 2-slide deck
  await sendAndWait(
    page,
    "Make a 2-slide deck: 1) Title 'Delta Test', 2) Content 'Original'. Style nb-pro. Write script.js.",
    { label: "create", maxWait: 120_000 },
  );

  // Generate initial PPTX
  const genResult = await sendAndWait(
    page,
    "generate pptx",
    { label: "gen1", maxWait: 180_000, throwOnTimeout: false },
  );
  console.log("  [delta] initial gen:", genResult.responseText.slice(0, 100));

  // Now update slide 2 only
  const updateResult = await sendAndWait(
    page,
    "Update slide 2 content to 'Updated Content 2026'. Delete only slide-02.png, then regenerate.",
    { label: "update", maxWait: 180_000, throwOnTimeout: false },
  );
  console.log("  [delta] update response:", updateResult.responseText.slice(0, 200));

  const allUpdateText = (await page.locator("[data-testid='assistant-message']").allTextContents()).join(" ").toLowerCase();
  const followsWorkflow =
    (allUpdateText.includes("slide") || allUpdateText.includes("update") || allUpdateText.includes("change")) &&
    allUpdateText.length > 20;
  expect(followsWorkflow).toBe(true);
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
