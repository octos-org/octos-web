import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeSettingsProvider } from "./home-settings-context";
import { useWeather } from "./use-weather";

const apiMocks = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
  updateMyProfileConfig: vi.fn(),
}));

vi.mock("@/settings/settings-api", () => ({
  getMyProfile: apiMocks.getMyProfile,
  updateMyProfileConfig: apiMocks.updateMyProfileConfig,
}));

function profileWithoutHomeCity() {
  return {
    id: "admin",
    name: "Admin",
    enabled: true,
    data_dir: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    status: { running: true, pid: 1234, started_at: null, uptime_secs: 3600 },
    config: {
      llm: {
        primary: { family_id: "openai", model_id: "gpt-5.4" },
        fallbacks: [],
      },
      home: {
        settings: { city: "" },
        events: [],
        photos: [],
        widgets: [],
        metro_layout: {},
      },
      channels: [],
      gateway: {
        max_history: null,
        max_iterations: null,
        system_prompt: null,
        max_concurrent_sessions: null,
        browser_timeout_secs: null,
        max_output_tokens: null,
      },
      env_vars: {},
      hooks: [],
      email: null,
      api_type: null,
      admin_mode: true,
      sandbox: {
        enabled: false,
        mode: "off",
        allow_network: false,
        docker: {
          image: "ubuntu:24.04",
          cpu_limit: null,
          memory_limit: null,
          pids_limit: null,
          mount_mode: "read_only",
          extra_binds: [],
        },
        read_allow_paths: [],
      },
      adaptive_routing: null,
      content_routing: null,
      plugins: { require_signed: false },
    },
  };
}

function WeatherProbe() {
  const weather = useWeather();
  return (
    <div>
      <span data-testid="loading">{weather.loading ? "yes" : "no"}</span>
      <span data-testid="error">{weather.error ?? ""}</span>
      <span data-testid="city">{weather.city ?? ""}</span>
    </div>
  );
}

describe("useWeather", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    apiMocks.getMyProfile.mockReset();
    apiMocks.updateMyProfileConfig.mockReset();
    apiMocks.getMyProfile.mockResolvedValue(profileWithoutHomeCity());
    apiMocks.updateMyProfileConfig.mockImplementation(async (profile, patch) => ({
      ...profile,
      config: { ...profile.config, ...patch },
    }));
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: undefined,
    });
  });

  it("does not call IP geolocation or fall back to a hardcoded city when location resolution fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`unexpected weather request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <HomeSettingsProvider>
        <WeatherProbe />
      </HomeSettingsProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("no"));
    expect(screen.getByTestId("error").textContent).toBe("location_unavailable");
    expect(screen.getByTestId("city").textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
