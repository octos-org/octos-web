import path from "node:path";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const SAMPLE_PATH = path.resolve(
  process.cwd(),
  "public/wake-word/sample-nihao-xiaozhangyu.wav",
);

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${SAMPLE_PATH}`,
    ],
  },
});

test("Home auto-listens and opens voice mode when the wake phrase is heard", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);

  await context.grantPermissions(["microphone"]);
  await login(page);

  await page.route("**/api/admin/ominix/runtime", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "healthy",
        url: "http://127.0.0.1:18888",
        url_source: "test",
        port: 18888,
        home_dir: "/tmp/octos-e2e",
        ominix_dir: "/tmp/octos-e2e/.ominix",
        binary_path: "/tmp/octos-e2e/.ominix/bin/ominix-api",
        binary_installed: true,
        metallib_path: "/tmp/octos-e2e/.ominix/ominix.metallib",
        metallib_installed: true,
        models_dir: "/tmp/octos-e2e/.ominix/models",
        models_dir_exists: true,
        plist_path: "/tmp/octos-e2e/Library/LaunchAgents/io.ominix.ominix-api.plist",
        plist_exists: true,
        plist_port: 18888,
        discovery_path: "/tmp/octos-e2e/.ominix/api_url",
        discovery_url: "http://127.0.0.1:18888",
        service_registered: true,
        service_running: true,
        launchctl_skipped: false,
        health: { healthy: true, http_status: 200 },
        voice_models_ready: true,
        voice_models: [
          { id: "whisper-base", role: "asr", status: "ready", ready: true },
          { id: "kokoro", role: "tts", status: "ready", ready: true },
        ],
        issues: [],
        can_repair: true,
        suggested_action: "none",
      }),
    });
  });

  await page.goto("/home", { waitUntil: "networkidle" });
  await expect(page.getByText("Voice engine ready").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page).toHaveURL(/\/voice/, { timeout: 60_000 });
  await expect(page.getByLabel("voice orb")).toBeVisible({ timeout: 20_000 });
});
