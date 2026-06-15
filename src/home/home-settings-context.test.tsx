import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HomeSettingsProvider,
  useHomeSettings,
  type HomeSettingsContextValue,
} from "./home-settings-context";

const apiMocks = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
  updateMyProfileConfig: vi.fn(),
}));

vi.mock("@/settings/settings-api", () => ({
  getMyProfile: apiMocks.getMyProfile,
  updateMyProfileConfig: apiMocks.updateMyProfileConfig,
}));

function profileWithHome(home: Record<string, unknown> | null = null) {
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
      home,
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

function Probe({ onValue }: { onValue?: (value: HomeSettingsContextValue) => void }) {
  const home = useHomeSettings();
  onValue?.(home);
  return (
    <div>
      <span data-testid="city">{home.city}</span>
      <span data-testid="ui-style">{home.uiStyle}</span>
      <span data-testid="burn-in">{home.burnInProtection ? "on" : "off"}</span>
      <span data-testid="photos">{home.photos.join("|")}</span>
      <span data-testid="events">{home.events.map((event) => event.title).join("|")}</span>
      <button onClick={() => home.update({ city: "Kyoto" })}>Set city</button>
      <button onClick={() => home.update({ uiStyle: "classic" })}>Set classic</button>
      <button onClick={() => home.update({ burnInProtection: true })}>Enable burn-in</button>
      <button
        onClick={() =>
          home.addEvent({
            title: "Dinner",
            time: "19:00",
            date: "2026-06-14",
            recurring: "daily",
          })
        }
      >
        Add event
      </button>
      <button onClick={() => home.addPhoto("https://example.test/family.jpg")}>
        Add photo
      </button>
      <button onClick={() => home.setMetroLayout({ clock: { col: 1, row: 1, w: 4, h: 2 } })}>
        Set layout
      </button>
    </div>
  );
}

describe("HomeSettingsProvider", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    apiMocks.getMyProfile.mockReset();
    apiMocks.updateMyProfileConfig.mockReset();
    apiMocks.updateMyProfileConfig.mockImplementation(async (profile, patch) => ({
      ...profile,
      config: { ...profile.config, ...patch },
    }));
  });

  it("loads Home dashboard state from the profile config", async () => {
    apiMocks.getMyProfile.mockResolvedValue(
      profileWithHome({
        settings: {
          city: "Tokyo",
          temp_unit: "F",
          clock_format: "12h",
          idle_seconds: 60,
          night_mode: "on",
          burn_in_protection: true,
          lang: "zh",
          news_feed_url: "https://example.test/feed.xml",
          ui_style: "classic",
        },
        events: [
          {
            id: "evt-1",
            title: "Breakfast",
            time: "08:00",
            date: "2026-06-14",
          },
        ],
        photos: ["https://example.test/home.jpg"],
        widgets: [{ type: "clock", enabled: false, order: 1 }],
        metro_layout: { clock: { col: 1, row: 1, w: 4, h: 2 } },
      }),
    );

    render(
      <HomeSettingsProvider>
        <Probe />
      </HomeSettingsProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("city").textContent).toBe("Tokyo"));
    expect(screen.getByTestId("ui-style").textContent).toBe("classic");
    expect(screen.getByTestId("burn-in").textContent).toBe("on");
    expect(screen.getByTestId("events").textContent).toBe("Breakfast");
    expect(screen.getByTestId("photos").textContent).toBe("https://example.test/home.jpg");
  });

  it("persists Home edits back into profile config.home", async () => {
    const profile = profileWithHome({
      settings: { city: "Tokyo" },
      events: [],
      photos: [],
      widgets: [],
      metro_layout: {},
    });
    apiMocks.getMyProfile.mockResolvedValue(profile);

    render(
      <HomeSettingsProvider>
        <Probe />
      </HomeSettingsProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("city").textContent).toBe("Tokyo"));

    await act(async () => {
      screen.getByText("Set city").click();
      screen.getByText("Set classic").click();
      screen.getByText("Enable burn-in").click();
      screen.getByText("Add event").click();
      screen.getByText("Add photo").click();
      screen.getByText("Set layout").click();
    });

    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const lastCall = apiMocks.updateMyProfileConfig.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ id: "admin" });
    expect(lastCall?.[1]).toMatchObject({
      home: {
        settings: {
          city: "Kyoto",
          ui_style: "classic",
          burn_in_protection: true,
        },
        events: [expect.objectContaining({ title: "Dinner" })],
        photos: ["https://example.test/family.jpg"],
        metro_layout: { clock: { col: 1, row: 1, w: 4, h: 2 } },
      },
    });
  });

  it("migrates legacy localStorage Home data into the profile once", async () => {
    localStorage.setItem("octos_home_city", "Osaka");
    localStorage.setItem("octos_home_ui_style", "classic");
    localStorage.setItem(
      "octos_home_events",
      JSON.stringify([
        {
          id: "evt-legacy",
          title: "Lunch",
          time: "12:00",
          date: "2026-06-14",
        },
      ]),
    );
    localStorage.setItem("octos_home_photos", JSON.stringify(["https://example.test/legacy.jpg"]));
    apiMocks.getMyProfile.mockResolvedValue(profileWithHome(null));

    render(
      <HomeSettingsProvider>
        <Probe />
      </HomeSettingsProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("city").textContent).toBe("Osaka"));
    await waitFor(() =>
      expect(apiMocks.updateMyProfileConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: "admin" }),
        expect.objectContaining({
          home: expect.objectContaining({
            settings: expect.objectContaining({
              city: "Osaka",
              ui_style: "classic",
            }),
            events: [expect.objectContaining({ title: "Lunch" })],
            photos: ["https://example.test/legacy.jpg"],
          }),
        }),
      ),
    );
  });
});
