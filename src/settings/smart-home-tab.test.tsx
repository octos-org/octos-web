import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SmartHomeTab } from "./smart-home-tab";
import type { Profile } from "./settings-api";

const apiMocks = vi.hoisted(() => ({
  updateMyProfileConfig: vi.fn(),
  formatSettingsError: vi.fn((err: unknown, fallback = "Request failed.") =>
    err instanceof Error ? err.message : fallback,
  ),
}));

vi.mock("./settings-api", () => apiMocks);

const bridgeMocks = vi.hoisted(() => ({
  callMethod: vi.fn(),
}));

vi.mock("@/runtime/ui-protocol-runtime", () => ({
  ensureAuxBridge: vi.fn(async () => ({ callMethod: bridgeMocks.callMethod })),
}));

vi.mock("@/runtime/ui-protocol-bridge", () => ({
  METHODS: { SMART_HOME_DEVICE_LIST: "smart_home/device.list" },
}));

function makeProfile(smartHome: Profile["config"]["smart_home"]): Profile {
  return {
    id: "p1",
    name: "P1",
    enabled: true,
    data_dir: null,
    config: {
      llm: { primary: {}, fallbacks: [] },
      channels: [],
      gateway: {},
      env_vars: {},
      hooks: [],
      email: null,
      api_type: null,
      admin_mode: false,
      sandbox: {},
      adaptive_routing: null,
      content_routing: null,
      plugins: { require_signed: false },
      smart_home: smartHome,
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as unknown as Profile;
}

describe("SmartHomeTab", () => {
  beforeEach(() => {
    cleanup();
    apiMocks.updateMyProfileConfig.mockReset();
    bridgeMocks.callMethod.mockReset();
  });

  it("prefills bridge url and token env from the profile", () => {
    render(
      <SmartHomeTab
        profile={makeProfile({
          bridge_url: "http://192.168.1.50:8787",
          token: "abcd***xyz",
          token_env: "SH_TOKEN",
        })}
        onProfileUpdated={vi.fn()}
      />,
    );

    expect(
      (screen.getByLabelText(/Bridge URL/) as HTMLInputElement).value,
    ).toBe("http://192.168.1.50:8787");
    expect(
      (screen.getByLabelText(/Token env var/) as HTMLInputElement).value,
    ).toBe("SH_TOKEN");
    // Stored token is only echoed as a placeholder, never as input value.
    const token = screen.getByLabelText(/Auth token/) as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.placeholder).toContain("unchanged");
  });

  it("saves a new bridge config, sending the typed token", async () => {
    const onProfileUpdated = vi.fn();
    const updated = makeProfile({ bridge_url: "http://10.0.0.2:8787" });
    apiMocks.updateMyProfileConfig.mockResolvedValue(updated);

    render(<SmartHomeTab profile={makeProfile(null)} onProfileUpdated={onProfileUpdated} />);

    fireEvent.change(screen.getByLabelText(/Bridge URL/), {
      target: { value: "http://10.0.0.2:8787" },
    });
    fireEvent.change(screen.getByLabelText(/Auth token/), {
      target: { value: "fresh-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const [, patch] = apiMocks.updateMyProfileConfig.mock.calls[0];
    expect(patch).toEqual({
      smart_home: {
        bridge_url: "http://10.0.0.2:8787",
        token: "fresh-token",
        token_env: null,
      },
    });
    expect(onProfileUpdated).toHaveBeenCalledWith(updated);
  });

  it("echoes the stored masked token when the user does not type a new one", async () => {
    apiMocks.updateMyProfileConfig.mockResolvedValue(
      makeProfile({ bridge_url: "http://192.168.1.50:8787", token: "abcd***xyz" }),
    );

    render(
      <SmartHomeTab
        profile={makeProfile({
          bridge_url: "http://192.168.1.50:8787",
          token: "abcd***xyz",
        })}
        onProfileUpdated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const [, patch] = apiMocks.updateMyProfileConfig.mock.calls[0];
    // The masked echo is safe: the backend's save_with_merge restores it.
    expect(patch.smart_home.token).toBe("abcd***xyz");
  });

  it("clears the whole section when the bridge url is emptied", async () => {
    apiMocks.updateMyProfileConfig.mockResolvedValue(makeProfile(null));

    render(
      <SmartHomeTab
        profile={makeProfile({ bridge_url: "http://192.168.1.50:8787" })}
        onProfileUpdated={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Bridge URL/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const [, patch] = apiMocks.updateMyProfileConfig.mock.calls[0];
    expect(patch).toEqual({ smart_home: null });
  });

  it("shows the save error when the request fails", async () => {
    apiMocks.updateMyProfileConfig.mockRejectedValue(new Error("boom"));

    render(
      <SmartHomeTab
        profile={makeProfile({ bridge_url: "http://192.168.1.50:8787" })}
        onProfileUpdated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("boom"));
  });

  it("reports device count on a successful connection test", async () => {
    bridgeMocks.callMethod.mockResolvedValue({
      devices: { ok: true, devices: [{ id: "a" }, { id: "b" }] },
    });

    render(
      <SmartHomeTab
        profile={makeProfile({ bridge_url: "http://192.168.1.50:8787" })}
        onProfileUpdated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(screen.getByText(/Connected — 2 devices found\./)).toBeTruthy(),
    );
    expect(bridgeMocks.callMethod).toHaveBeenCalledWith("smart_home/device.list", {});
  });

  it("reports the bridge error on a failed connection test", async () => {
    bridgeMocks.callMethod.mockResolvedValue({
      devices: { ok: false, error: "hub unreachable" },
    });

    render(
      <SmartHomeTab
        profile={makeProfile({ bridge_url: "http://192.168.1.50:8787" })}
        onProfileUpdated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(screen.getByText(/Bridge error: hub unreachable/)).toBeTruthy(),
    );
  });
});
