import { defineConfig } from "@playwright/test";

if (!process.env.OCTOS_LIVE_REVIEW_URL || !process.env.OCTOS_LIVE_REVIEW_CREDENTIALS) {
  throw new Error("Set OCTOS_LIVE_REVIEW_URL and OCTOS_LIVE_REVIEW_CREDENTIALS for an isolated real server.");
}

export default defineConfig({
  testDir: "./tests/live-review",
  testMatch: process.env.OCTOS_LIVE_REVIEW_SOAK === "1" ? "soak.spec.ts" : "core.spec.ts",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/live-review/results.json" }]],
  outputDir: "test-results/live-review/artifacts",
  use: {
    baseURL: process.env.OCTOS_LIVE_REVIEW_URL,
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    // Traces contain authenticated WebSocket URLs. Keep secrets out of reports.
    trace: "off",
    screenshot: "only-on-failure",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  },
});
