import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const loadVoices = vi.fn();
const selectVoice = vi.fn();
const getMyProfile = vi.fn();
let mockStore = {
  voices: [
    { id: "doubao", aliases: ["vivian"] },
    { id: "yangmi", aliases: [] },
  ],
  current: "doubao",
  status: "ready" as const,
};

vi.mock("@/store/voice-store", () => ({
  useVoiceStore: () => mockStore,
  loadVoices: () => loadVoices(),
  selectVoice: (id: string) => selectVoice(id),
}));

vi.mock("@/settings/settings-api", () => ({
  getMyProfile: () => getMyProfile(),
}));

import { VoiceSelector } from "./voice-selector";

describe("VoiceSelector (pills)", () => {
  beforeEach(() => {
    cleanup();
    loadVoices.mockReset();
    selectVoice.mockReset().mockResolvedValue(undefined);
    // Default: on-device route → switcher visible.
    getMyProfile.mockReset().mockResolvedValue({ config: { tts_provider: "local" } });
    mockStore = {
      voices: [
        { id: "doubao", aliases: ["vivian"] },
        { id: "yangmi", aliases: [] },
      ],
      current: "doubao",
      status: "ready",
    };
  });

  it("renders one option per voice, using the alias as label, marking current", () => {
    render(<VoiceSelector />);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    // Alias label for doubao, id for yangmi.
    expect(screen.getByText("vivian")).toBeTruthy();
    expect(screen.getByText("yangmi")).toBeTruthy();
    const current = screen.getByRole("option", { selected: true });
    expect(current.textContent).toBe("vivian");
  });

  it("calls selectVoice when a different voice is picked", () => {
    render(<VoiceSelector />);
    fireEvent.click(screen.getByText("yangmi"));
    expect(selectVoice).toHaveBeenCalledWith("yangmi");
  });

  it("does not call selectVoice when the current voice is re-picked", () => {
    render(<VoiceSelector />);
    fireEvent.click(screen.getByText("vivian")); // already current
    expect(selectVoice).not.toHaveBeenCalled();
  });

  it("hides the on-device switcher when the cloud route is selected", async () => {
    getMyProfile.mockResolvedValue({ config: { tts_provider: "cloud" } });
    render(<VoiceSelector />);
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(screen.queryByText("vivian")).toBeNull();
  });
});
