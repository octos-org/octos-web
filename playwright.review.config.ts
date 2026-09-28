import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["review-correctness.spec.ts", "ui-redesign-smoke.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/review",
  use: {
    baseURL: "http://127.0.0.1:5176",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  },
  webServer: [
    { command: "node scripts/copy-vad-assets.mjs && node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5176 --strictPort", url: "http://127.0.0.1:5176", reuseExistingServer: false },
    { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5177 --strictPort", env: { BASE_URL: "/app/" }, url: "http://127.0.0.1:5177/app/", reuseExistingServer: false },
  ],
});
