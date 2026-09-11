import { defineConfig } from "@playwright/test";

const suite = process.env.OCTOS_LIVE_REVIEW_SOAK === "1" ? "soak" : "core";
const reportDir = `test-results/live-review-${suite}`;

if (!process.env.OCTOS_LIVE_REVIEW_URL || !process.env.OCTOS_LIVE_REVIEW_CREDENTIALS) {
  throw new Error("Set OCTOS_LIVE_REVIEW_URL and OCTOS_LIVE_REVIEW_CREDENTIALS for an isolated real server.");
}

export default defineConfig({
  testDir: "./tests/live-review",
  testMatch: `${suite}.spec.ts`,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: `${reportDir}/results.json` }]],
  outputDir: `${reportDir}/artifacts`,
  use: {
    baseURL: process.env.OCTOS_LIVE_REVIEW_URL,
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    // Traces contain authenticated WebSocket URLs. Keep secrets out of reports.
    trace: "off",
    screenshot: "only-on-failure",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  },
});
