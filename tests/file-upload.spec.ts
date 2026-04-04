import { test, expect } from "@playwright/test";
import { login, sendAndWait, SEL } from "./helpers";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_CSV = path.join(__dirname, "fixtures", "test-data.csv");
const TEST_MD = path.join(__dirname, "fixtures", "test-doc.md");

test.describe("File upload", () => {
  test.beforeAll(() => {
    // Create test fixtures
    const fixturesDir = path.join(__dirname, "fixtures");
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });

    fs.writeFileSync(TEST_CSV, [
      "name,email,role",
      "Alice,alice@example.com,admin",
      "Bob,bob@example.com,user",
      "Charlie,charlie@example.com,user",
    ].join("\n"));

    fs.writeFileSync(TEST_MD, [
      "# Test Document",
      "",
      "This is a test markdown file for upload testing.",
      "",
      "## Section 1",
      "Some content here.",
    ].join("\n"));
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("CSV file upload and agent reads content", async ({ page }) => {
    // Attach file via the file input
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles(TEST_CSV);
    await page.waitForTimeout(1000);

    // Send message asking about the file
    const result = await sendAndWait(page, "What data is in this CSV file? List the names.", {
      label: "csv-upload",
      maxWait: 60_000,
    });

    console.log(`CSV response: "${result.responseText.slice(0, 200)}"`);
    expect(result.responseLen).toBeGreaterThan(0);
    // Agent should have read the file and found the names
    const text = result.responseText.toLowerCase();
    expect(text.includes("alice") || text.includes("bob") || text.includes("charlie")).toBe(true);
  });

  test("Markdown file upload and agent reads content", async ({ page }) => {
    const fileInput = page.locator("input[type='file']");
    await fileInput.setInputFiles(TEST_MD);
    await page.waitForTimeout(1000);

    const result = await sendAndWait(page, "What is the title of this document?", {
      label: "md-upload",
      maxWait: 60_000,
    });

    console.log(`MD response: "${result.responseText.slice(0, 200)}"`);
    expect(result.responseLen).toBeGreaterThan(0);
    const text = result.responseText.toLowerCase();
    expect(text.includes("test document") || text.includes("test") || text.includes("document")).toBe(true);
  });
});
