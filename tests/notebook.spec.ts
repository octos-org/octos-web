import { test, expect } from "@playwright/test";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "test-token-123";
const BASE = "http://localhost:5174";

async function login(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.locator("button", { hasText: "Auth Token" }).click();
  await page.locator("[data-testid='token-input']").fill(AUTH_TOKEN);
  await page.locator("[data-testid='login-button']").click();
  await page.waitForURL("**/", { timeout: 15_000 });
}

test.describe("MoFa Notebook", () => {
  test("sidebar shows Notebooks and Chat tabs", async ({ page }) => {
    await login(page);
    // Should see both nav tabs
    await expect(page.locator("button", { hasText: "Notebooks" })).toBeVisible();
    await expect(page.getByRole("complementary").getByRole("button", { name: "Chat", exact: true })).toBeVisible();
  });

  test("navigate to notebooks list page", async ({ page }) => {
    await login(page);
    await page.locator("button", { hasText: "Notebooks" }).click();
    await page.waitForURL("**/notebooks", { timeout: 5_000 });

    // Should see the header
    await expect(page.locator("text=MoFa Notebook")).toBeVisible();
    await expect(page.locator("text=New Notebook")).toBeVisible();
  });

  test("create a new notebook", async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/notebooks`, { waitUntil: "networkidle" });

    // Click "New Notebook"
    await page.locator("button", { hasText: "New Notebook" }).click();

    // Fill title
    const titleInput = page.locator("input[placeholder='Notebook title...']");
    await expect(titleInput).toBeVisible();
    await titleInput.fill("Test Notebook");

    // Click Create
    await page.locator("button", { hasText: "Create" }).last().click();

    // Should navigate to notebook detail
    await page.waitForURL("**/notebooks/*", { timeout: 5_000 });

    // Should see the notebook title and tabs
    await expect(page.locator("text=Test Notebook")).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Sources" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Notes" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Studio" })).toBeVisible();
  });

  test("notebook detail tabs work", async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/notebooks`, { waitUntil: "networkidle" });

    // Create a notebook first
    await page.locator("button", { hasText: "New Notebook" }).click();
    await page.locator("input[placeholder='Notebook title...']").fill("Tab Test");
    await page.locator("button", { hasText: "Create" }).last().click();
    await page.waitForURL("**/notebooks/*", { timeout: 5_000 });

    // Click Sources tab
    await page.locator("button", { hasText: "Sources" }).click();
    await expect(page.locator("text=No sources yet")).toBeVisible();
    await expect(page.locator("text=Add Source")).toBeVisible();

    // Click Notes tab
    await page.locator("button", { hasText: "Notes" }).click();
    await expect(page.locator("text=No notes yet")).toBeVisible();

    // Click Studio tab
    await page.locator("button", { hasText: "Studio" }).click();
    await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
    await expect(page.locator("text=Slides")).toBeVisible();
    await expect(page.locator("text=Quiz")).toBeVisible();
    await expect(page.locator("text=Flashcards")).toBeVisible();
    await expect(page.locator("text=Mind Map")).toBeVisible();

    // Click Chat tab (in the main area header)
    await page.getByRole("main").getByRole("button", { name: "Chat" }).click();
    await expect(page.locator("text=Chat with your sources")).toBeVisible();
  });

  test("navigate back to notebooks list", async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/notebooks`, { waitUntil: "networkidle" });

    // Create notebook
    await page.locator("button", { hasText: "New Notebook" }).click();
    await page.locator("input[placeholder='Notebook title...']").fill("Back Nav Test");
    await page.locator("button", { hasText: "Create" }).last().click();
    await page.waitForURL("**/notebooks/*", { timeout: 5_000 });

    // Click back arrow (first button in main header area)
    await page.getByRole("main").locator("button").first().click();
    await page.waitForURL("**/notebooks", { timeout: 10_000 });

    // Should see the notebook in the list
    await expect(page.locator("text=Back Nav Test")).toBeVisible();
  });

  test("notebook shows in list after creation", async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/notebooks`, { waitUntil: "networkidle" });

    // Create two notebooks
    for (const title of ["Physics 101", "Chemistry Lab"]) {
      await page.locator("button", { hasText: "New Notebook" }).click();
      await page.locator("input[placeholder='Notebook title...']").fill(title);
      await page.locator("button", { hasText: "Create" }).last().click();
      await page.waitForURL("**/notebooks/*", { timeout: 5_000 });
      await page.goto(`${BASE}/notebooks`, { waitUntil: "networkidle" });
    }

    // Both should appear
    await expect(page.locator("text=Physics 101")).toBeVisible();
    await expect(page.locator("text=Chemistry Lab")).toBeVisible();
  });

  test("switch between Notebooks and Chat mode", async ({ page }) => {
    await login(page);

    // Start in Chat mode
    await expect(page.locator("[data-testid='chat-input']")).toBeVisible();

    // Switch to Notebooks
    await page.locator("button", { hasText: "Notebooks" }).click();
    await page.waitForURL("**/notebooks", { timeout: 5_000 });
    await expect(page.locator("text=MoFa Notebook")).toBeVisible();

    // Switch back to Chat
    await page.getByRole("complementary").getByRole("button", { name: "Chat" }).click();
    await page.waitForURL(/\/$/, { timeout: 5_000 });
    await expect(page.locator("[data-testid='chat-input']")).toBeVisible();
  });

  test("studio panel shows all output types", async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/notebooks`, { waitUntil: "networkidle" });

    await page.locator("button", { hasText: "New Notebook" }).click();
    await page.locator("input[placeholder='Notebook title...']").fill("Studio Test");
    await page.locator("button", { hasText: "Create" }).last().click();
    await page.waitForURL("**/notebooks/*", { timeout: 5_000 });

    await page.locator("button", { hasText: "Studio" }).click();

    const expectedTypes = ["Slides", "Quiz", "Flashcards", "Mind Map", "Audio", "Infographic", "Comic", "Report", "Research"];
    for (const t of expectedTypes) {
      await expect(page.locator(`text=${t}`).first()).toBeVisible();
    }
  });
});
