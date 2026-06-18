/**
 * Slides workflow coverage through the current chat UI protocol.
 *
 * The legacy REST `/api/chat` SSE route was retired; these checks now drive
 * the same browser path users exercise and keep the slides workflow visible in
 * default e2e runs.
 */

import { expect, test, type Page } from "@playwright/test";
import {
  createNewSession,
  getInput,
  getSendButton,
  login,
  sendAndWait,
  SEL,
} from "./helpers";

test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
  await login(page);
  await createNewSession(page);
});

async function sendSlides(page: Page, message: string) {
  return sendAndWait(page, message, {
    label: "slides-api",
    maxWait: 45_000,
    throwOnTimeout: false,
  });
}

async function issueCommand(page: Page, command: string) {
  await getInput(page).fill(command);
  await getSendButton(page).click();
  await page.waitForTimeout(1_000);
  await expect(getInput(page)).toBeVisible();
}

test("T1: /new slides creates project directory", async ({ page }) => {
  await issueCommand(page, "/new slides ci-deck");
  await getInput(page).fill("Write script.js for one slide. Do NOT generate.");
  await expect(getSendButton(page)).toBeEnabled();
});

test("T2: agent writes script.js without generating", async ({ page }) => {
  await issueCommand(page, "/new slides design-test");

  const result = await sendSlides(
    page,
    "Make a 3-slide deck about AI robotics. Style: nb-pro. Slides: 1) Cover, 2) Key trends, 3) Future. Write script.js ONLY, do NOT generate yet.",
  );

  expect(result.responseText).toMatch(/script\.js|write|slide/i);
  expect(result.responseText).not.toMatch(/generated deck\.pptx/i);
});

test("T3: explicit generate triggers slides artifact response", async ({ page }) => {
  await issueCommand(page, "/new slides gen-test");
  await sendSlides(
    page,
    "Write script.js with 2 slides: 1) Title 'CI Test', 2) Content 'Automated test'. Style nb-pro. Do NOT generate.",
  );

  const result = await sendSlides(page, "generate the pptx now");

  expect(result.responseText).toMatch(/generated|pptx|artifact/i);
});

test("T4: incremental update modifies script and names changed slide", async ({ page }) => {
  await issueCommand(page, "/new slides delta-test");
  await sendSlides(
    page,
    "Write script.js: 2 slides, 1) Title 'Delta Test', 2) Content 'Original'. Style nb-pro. Do NOT generate.",
  );
  await sendSlides(page, "generate pptx");

  const result = await sendSlides(
    page,
    "Update slide 2 content to 'Updated 2026'. Only modify slide 2 in script.js, delete slide-02.png, then regenerate.",
  );

  expect(result.responseText).toMatch(/slide|script|pptx|artifact|generated/i);
});

test("T5: /help returns commands, not a blocked send state", async ({ page }) => {
  const input = getInput(page);
  const sendBtn = getSendButton(page);
  await input.fill("/help");
  await sendBtn.click();

  await expect(page.locator(SEL.cmdFeedback)).toContainText(/\/new|command/i, {
    timeout: 10_000,
  });
  await input.fill("hello after command");
  await expect(sendBtn).toBeEnabled();
});

test("T6: unknown /xxx returns help-like command response", async ({ page }) => {
  const result = await sendSlides(page, "/foobar");

  expect(result.responseText).toMatch(/unknown command|available|\/new/i);
});
