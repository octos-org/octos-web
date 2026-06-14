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
  fetchPlatformSkillHealth: vi.fn(),
  fetchPlatformSkillsStatus: vi.fn(),
  formatSettingsError: vi.fn((err: unknown, fallback = "Request failed.") =>
    err instanceof Error ? err.message : fallback,
  ),
  installPlatformSkill: vi.fn(),
  removeOminixModel: vi.fn(),
  removePlatformSkill: vi.fn(),
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
