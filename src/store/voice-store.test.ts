import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/voice", () => ({
  getVoices: vi.fn(),
  setVoice: vi.fn(),
}));

import { getVoices, setVoice } from "@/api/voice";
import {
  __resetVoiceStoreForTests,
  getVoiceState,
  loadVoices,
  selectVoice,
} from "@/store/voice-store";

const mockGet = getVoices as unknown as ReturnType<typeof vi.fn>;
const mockSet = setVoice as unknown as ReturnType<typeof vi.fn>;

describe("voice-store", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
    __resetVoiceStoreForTests();
  });

  it("loadVoices populates voices + current and marks ready", async () => {
    mockGet.mockResolvedValue({
      voices: [
        { id: "doubao", aliases: ["vivian"] },
        { id: "yangmi", aliases: [] },
      ],
      current: "doubao",
    });
    await loadVoices();
    const s = getVoiceState();
    expect(s.status).toBe("ready");
    expect(s.current).toBe("doubao");
    expect(s.voices.map((v) => v.id)).toEqual(["doubao", "yangmi"]);
  });

  it("selectVoice updates optimistically then canonicalises from the response", async () => {
    mockGet.mockResolvedValue({ voices: [], current: "doubao" });
    await loadVoices();
    mockSet.mockResolvedValue({ ok: true, voice: "yangmi" });

    const p = selectVoice("vivian"); // alias → backend canonicalises to a real id
    expect(getVoiceState().current).toBe("vivian"); // optimistic, before resolve
    await p;
    expect(mockSet).toHaveBeenCalledWith("vivian");
    expect(getVoiceState().current).toBe("yangmi"); // canonical from server
  });

  it("selectVoice reverts to the previous voice when the request fails", async () => {
    mockGet.mockResolvedValue({ voices: [], current: "doubao" });
    await loadVoices();
    mockSet.mockRejectedValue(new Error("boom"));

    await expect(selectVoice("yangmi")).rejects.toThrow("boom");
    expect(getVoiceState().current).toBe("doubao"); // reverted
  });
});
