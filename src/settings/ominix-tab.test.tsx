import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OminixTab } from "./ominix-tab";

const apiMocks = vi.hoisted(() => ({
  disableOminixModel: vi.fn(),
  downloadOminixModel: vi.fn(),
  enableOminixModel: vi.fn(),
  fetchOminixAvailableModels: vi.fn(),
  fetchOminixLogs: vi.fn(),
  fetchOminixPlatformModels: vi.fn(),
  fetchOminixRuntimeStatus: vi.fn(),
  fetchPlatformSkillHealth: vi.fn(),
  fetchPlatformSkillsStatus: vi.fn(),
  formatSettingsError: vi.fn((err: unknown, fallback = "Request failed.") =>
    err instanceof Error ? err.message : fallback,
  ),
  installOminixRuntime: vi.fn(),
  installPlatformSkill: vi.fn(),
  removeOminixModel: vi.fn(),
  removePlatformSkill: vi.fn(),
  repairOminixRuntime: vi.fn(),
  runOminixServiceAction: vi.fn(),
}));

vi.mock("./settings-api", () => apiMocks);

describe("OminixTab catalog loading", () => {
  beforeEach(() => {
    cleanup();
    for (const mock of Object.values(apiMocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    }
    apiMocks.formatSettingsError.mockImplementation(
      (err: unknown, fallback = "Request failed.") =>
        err instanceof Error ? err.message : fallback,
    );
    apiMocks.fetchPlatformSkillsStatus.mockResolvedValue({
      platform_skills: [],
      skills_dir: "/tmp/skills",
      ominix_api: {
        url: "http://localhost:8080",
        healthy: true,
        service_registered: false,
      },
      models: {
        dir: "/tmp/models",
        asr: [],
        tts: [],
      },
    });
    apiMocks.fetchPlatformSkillHealth.mockResolvedValue({
      status: "healthy",
      url: "http://localhost:8080",
      detail: null,
    });
    apiMocks.fetchOminixRuntimeStatus.mockResolvedValue({
      state: "healthy",
      url: "http://localhost:8080",
      url_source: "env",
      port: 8080,
      home_dir: "/tmp",
      ominix_dir: "/tmp/.ominix",
      binary_path: "/tmp/bin/ominix-api",
      binary_installed: true,
      metallib_path: "/tmp/bin/mlx.metallib",
      metallib_installed: true,
      models_dir: "/tmp/models",
      models_dir_exists: true,
      plist_path: "/tmp/Library/LaunchAgents/io.ominix.ominix-api.plist",
      plist_exists: false,
      discovery_path: "/tmp/.ominix/api_url",
      service_registered: false,
      service_running: false,
      launchctl_skipped: true,
      health: { healthy: true, http_status: 200 },
      issues: [],
      can_repair: true,
      suggested_action: "ready",
    });
    apiMocks.fetchOminixPlatformModels.mockResolvedValue([]);
    apiMocks.fetchOminixAvailableModels.mockResolvedValue([]);
    apiMocks.fetchOminixLogs.mockResolvedValue({
      log_path: "/tmp/ominix.log",
      lines: [],
      error: null,
    });
  });

  it("does not request the available catalog while the service is not registered", async () => {
    render(<OminixTab />);

    expect(await screen.findByText("LaunchAgent missing")).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.fetchPlatformSkillsStatus).toHaveBeenCalled();
    });
    expect(apiMocks.fetchOminixAvailableModels).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Catalog sync is paused until OminiX API is installed/i),
    ).toBeTruthy();
  });
});
