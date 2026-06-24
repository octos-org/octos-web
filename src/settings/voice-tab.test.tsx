import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTab } from "./voice-tab";
import {
  normalizeProfileConfig,
  type Profile,
  type ProfileConfig,
} from "./settings-api";

const apiMocks = vi.hoisted(() => ({
  updateMyProfileConfig: vi.fn(),
  formatSettingsError: vi.fn((e: unknown, fb = "failed") =>
    e instanceof Error ? e.message : fb,
  ),
}));
// Keep the real module (normalizeProfileConfig etc.) and only spy the two
// functions VoiceTab calls at runtime.
vi.mock("./settings-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings-api")>();
  return { ...actual, ...apiMocks };
});

/** Build a fully-typed Profile from a partial config (no `as any`). */
function makeProfile(config: Partial<ProfileConfig>): Profile {
  return {
    id: "p1",
    name: "p1",
    enabled: true,
    data_dir: null,
    config: normalizeProfileConfig(config),
    created_at: "",
    updated_at: "",
    status: { running: false, pid: null, started_at: null, uptime_secs: null },
  };
}

const baseProfile = makeProfile({
  tts_provider: "cloud",
  tts_cloud: { appid: "123", voice: "BV700" },
  env_vars: { VOLC_TTS_TOKEN: "ab***yz" }, // masked => already set
});

describe("VoiceTab", () => {
  beforeEach(() => {
    cleanup();
    apiMocks.updateMyProfileConfig.mockReset();
    apiMocks.updateMyProfileConfig.mockResolvedValue(baseProfile);
  });

  it("should show cloud fields and render the appid in cleartext", () => {
    render(<VoiceTab profile={baseProfile} onProfileUpdated={() => {}} />);
    expect((screen.getByLabelText(/App ?ID/i) as HTMLInputElement).value).toBe("123");
    expect((screen.getByLabelText(/Voice/i) as HTMLSelectElement).value).toBe("BV700");
  });

  it("should omit an unchanged masked token from the save patch", async () => {
    render(<VoiceTab profile={baseProfile} onProfileUpdated={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const [, patch] = apiMocks.updateMyProfileConfig.mock.calls[0];
    // token left as the stored masked value (save_with_merge restores it)
    expect(patch.env_vars.VOLC_TTS_TOKEN).toBe("ab***yz");
    expect(patch.tts_provider).toBe("cloud");
    expect(patch.tts_cloud.appid).toBe("123");
  });

  it("should write a newly typed token into the save patch", async () => {
    render(<VoiceTab profile={baseProfile} onProfileUpdated={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Token/i), {
      target: { value: "newtoken123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const [, patch] = apiMocks.updateMyProfileConfig.mock.calls[0];
    expect(patch.env_vars.VOLC_TTS_TOKEN).toBe("newtoken123");
  });

  it("defaults to 'Inherit' when no tts_provider is set and clears the override on save", async () => {
    const inheritProfile = makeProfile({ env_vars: {} });
    render(<VoiceTab profile={inheritProfile} onProfileUpdated={() => {}} />);
    expect((screen.getByLabelText(/TTS route/i) as HTMLSelectElement).value).toBe(
      "inherit",
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const [, patch] = apiMocks.updateMyProfileConfig.mock.calls[0];
    expect(patch.tts_provider).toBeNull(); // clears override → inherit
  });

  it("does not create an empty tts_cloud override when none existed", async () => {
    // No tts_provider and no tts_cloud → Inherit save must send null, NOT `{}`,
    // otherwise the backend treats `{}` as a per-profile override and clobbers
    // the inherited server-level cloud config.
    const inheritProfile = makeProfile({ env_vars: {} });
    render(<VoiceTab profile={inheritProfile} onProfileUpdated={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const [, patch] = apiMocks.updateMyProfileConfig.mock.calls[0];
    expect(patch.tts_cloud).toBeNull();
    expect(patch.tts_cloud).not.toEqual({});
  });

  it("blocks save and shows an error when cloud route is missing credentials", () => {
    const incompleteCloud = makeProfile({
      tts_provider: "cloud",
      tts_cloud: {},
      env_vars: {},
    });
    render(<VoiceTab profile={incompleteCloud} onProfileUpdated={() => {}} />);
    const saveBtn = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/App ID/i);
  });

  it("no longer exposes a free-text endpoint field", () => {
    render(<VoiceTab profile={baseProfile} onProfileUpdated={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    expect(screen.queryByLabelText(/Endpoint/i)).toBeNull();
  });
});
