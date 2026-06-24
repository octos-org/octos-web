import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTab } from "./voice-tab";

const apiMocks = vi.hoisted(() => ({
  updateMyProfileConfig: vi.fn(),
  formatSettingsError: vi.fn((e: unknown, fb = "failed") =>
    e instanceof Error ? e.message : fb,
  ),
}));
vi.mock("./settings-api", () => apiMocks);

const baseProfile = {
  id: "p1",
  name: "p1",
  enabled: true,
  data_dir: null,
  config: {
    tts_provider: "cloud",
    tts_cloud: { appid: "123", voice: "BV700" },
    env_vars: { VOLC_TTS_TOKEN: "ab***yz" }, // masked => already set
  },
} as any;

describe("VoiceTab", () => {
  beforeEach(() => {
    cleanup();
    apiMocks.updateMyProfileConfig.mockReset();
    apiMocks.updateMyProfileConfig.mockResolvedValue(baseProfile);
  });

  it("should show cloud fields and render the appid in cleartext", () => {
    render(<VoiceTab profile={baseProfile} onProfileUpdated={() => {}} />);
    expect((screen.getByLabelText(/App ?ID/i) as HTMLInputElement).value).toBe("123");
    expect((screen.getByLabelText(/Voice/i) as HTMLInputElement).value).toBe("BV700");
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

  it("defaults to 'Inherit' when no tts_provider is set and sends null on save", async () => {
    const inheritProfile = {
      ...baseProfile,
      config: { env_vars: {} },
    } as any;
    render(<VoiceTab profile={inheritProfile} onProfileUpdated={() => {}} />);
    expect((screen.getByLabelText(/TTS route/i) as HTMLSelectElement).value).toBe(
      "inherit",
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiMocks.updateMyProfileConfig).toHaveBeenCalled());
    const [, patch] = apiMocks.updateMyProfileConfig.mock.calls[0];
    expect(patch.tts_provider).toBeNull(); // clears override → inherit
  });

  it("blocks save and shows an error when cloud route is missing credentials", () => {
    const incompleteCloud = {
      ...baseProfile,
      config: { tts_provider: "cloud", tts_cloud: {}, env_vars: {} },
    } as any;
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
