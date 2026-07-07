// FULL-BACKEND live E2E for the Ivory Obsidian launcher + /studio workspace.
// NO MOCKS: requires a real `octos serve` on :50080 (profile enabled, LLM
// configured, gateway process NOT running so serve hosts the runtime
// in-process), the frontend at $BASE_URL, and OCTOS_LIVE_E2E=1 so
// tests/helpers.ts skips the mock harness. Skips itself otherwise.
import path from "node:path";
import { expect, test } from "@playwright/test";
import { login, SEL } from "./helpers";

const SHOT_DIR = path.resolve(process.cwd(), "test-results/live-shots");
const PROBE = path.resolve(process.cwd(), "tests/fixtures/live-grounding-probe.md");

test.describe.configure({ mode: "serial" });
test.skip(
  process.env.OCTOS_LIVE_E2E !== "1",
  "live-only: set OCTOS_LIVE_E2E=1 with a real backend on :50080",
);
test.setTimeout(300_000);

async function sendChat(page: import("@playwright/test").Page, text: string) {
  const input = page.locator(SEL.chatInput);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(text);
  await page.locator(SEL.sendButton).click();
}

/** Wait until a NEW assistant message (index >= sinceCount) settles, return its text. */
async function waitForAssistantReply(
  page: import("@playwright/test").Page,
  sinceCount: number,
): Promise<string> {
  const messages = page.locator(SEL.assistantMessage);
  await expect
    .poll(async () => messages.count(), { timeout: 180_000, intervals: [1_000] })
    .toBeGreaterThan(sinceCount);
  const last = messages.nth(sinceCount);
  let prev = "";
  // settle: text stable for ~3s (stream finished)
  for (let i = 0; i < 90; i++) {
    const cur = (await last.innerText().catch(() => "")) ?? "";
    if (cur.trim() && cur === prev) break;
    prev = cur;
    await page.waitForTimeout(3_000);
  }
  return prev;
}

test("live: real chat turn on /chat", async ({ page }) => {
  await login(page);
  await page.goto("/chat", { waitUntil: "networkidle" });
  await sendChat(page, "Reply with exactly the text CHAT-LIVE-OK and nothing else.");
  const reply = await waitForAssistantReply(page, 0);
  expect(reply).toContain("CHAT-LIVE-OK");
});

test("live: full studio journey — create, converse, ground on uploaded source, skill send", async ({
  page,
}) => {
  await login(page);

  // 1. Launcher renders (Ivory Obsidian default skin).
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator(".studio-shell").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Octos Home" })).toBeVisible();
  await page.screenshot({ path: `${SHOT_DIR}/live-launcher.png` });

  // 2. Create a studio project through the real UI.
  await page.getByRole("button", { name: /Create new project/i }).click();
  await page.getByRole("button", { name: "Studio session", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/web-/);
  const projectUrl = page.url();

  // 3. Real bridge: composer appears once the WS session is open.
  await expect(page.locator(SEL.chatInput)).toBeVisible({ timeout: 60_000 });

  // 4. Real model turn inside the studio.
  await sendChat(page, "Reply with exactly the text STUDIO-LIVE-OK and nothing else.");
  const first = await waitForAssistantReply(page, 0);
  // Tolerate model imprecision (e.g. dropping the suffix) — the point is
  // a real streamed reply, not exact-string compliance.
  expect(first).toContain("STUDIO-LIVE");

  // 5. Upload a source through the Sources pane (real /api/upload).
  await page.getByTestId("studio-upload-input").setInputFiles(PROBE);
  await expect(page.getByText("live-grounding-probe.md").first()).toBeVisible({
    timeout: 30_000,
  });
  const checkbox = page.getByLabel("Use live-grounding-probe.md as source");
  await expect(checkbox).toBeChecked();
  await expect(page.getByText(/1 source attach/)).toBeVisible();

  // 6. Grounding proof: the model must read the codeword out of the
  //    attached file (upload → turn media → server materialization → LLM).
  await sendChat(
    page,
    "Read the attached markdown source and reply with the secret codeword it contains, exactly as written.",
  );
  const grounded = await waitForAssistantReply(page, 1);
  expect(grounded.toUpperCase()).toContain("AUBERGINE-42");
  await page.screenshot({ path: `${SHOT_DIR}/live-studio-grounded.png` });

  // 7. Skill tile send (bypasses the composer): translate the selected
  //    source; the translation must carry the codeword through, proving
  //    the rail attached the media itself.
  await page.getByRole("button", { name: "Language Translate" }).click();
  await expect(page.locator(SEL.userMessage).last()).toContainText(
    /Translate the attached sources/,
    { timeout: 30_000 },
  );
  const translated = await waitForAssistantReply(page, 2);
  expect(translated.toLowerCase()).toMatch(/aubergine/);
  await page.screenshot({ path: `${SHOT_DIR}/live-studio-skill.png` });

  // 8. Launcher lists the project we just created (title record seeding),
  //    and its card opens back into the same workspace.
  await page.goto("/", { waitUntil: "networkidle" });
  const id = projectUrl.split("/studio/")[1];
  const storedTitle = await page.evaluate((sessionId) => {
    try {
      const titles = JSON.parse(
        localStorage.getItem("octos_session_titles") ?? "{}",
      ) as Record<string, unknown>;
      const value = titles[sessionId];
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }, id);
  expect(storedTitle).toBeTruthy();
  const card = page.getByRole("button", { name: `Open ${storedTitle}` }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(projectUrl);
});
