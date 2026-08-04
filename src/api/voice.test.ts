import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  request: vi.fn(),
  requestBlob: vi.fn(),
}));

import { request, requestBlob } from "@/api/client";
import { getVoices, setVoice, synthesizeSpeech } from "@/api/voice";

const mockRequest = request as unknown as ReturnType<typeof vi.fn>;
const mockRequestBlob = requestBlob as unknown as ReturnType<typeof vi.fn>;

describe("voice api", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequestBlob.mockReset();
  });

  it("getVoices GETs /api/voices", async () => {
    mockRequest.mockResolvedValue({
      voices: [{ id: "doubao", aliases: ["vivian"] }],
      current: "doubao",
    });
    const res = await getVoices();
    expect(mockRequest).toHaveBeenCalledWith("/api/voices");
    expect(res.current).toBe("doubao");
    expect(res.voices[0].id).toBe("doubao");
  });

  it("setVoice PUTs /api/my/voice with the voice id", async () => {
    mockRequest.mockResolvedValue({ ok: true, voice: "yangmi" });
    const res = await setVoice("yangmi");
    expect(mockRequest).toHaveBeenCalledWith("/api/my/voice", {
      method: "PUT",
      body: JSON.stringify({ voice: "yangmi" }),
    });
    expect(res.voice).toBe("yangmi");
  });

  it("synthesizes text through the authenticated profile TTS route", async () => {
    const audio = new Blob(["audio"], { type: "audio/wav" });
    const controller = new AbortController();
    mockRequestBlob.mockResolvedValue(audio);

    await expect(
      synthesizeSpeech("先看这个圆。", controller.signal),
    ).resolves.toBe(audio);
    expect(mockRequestBlob).toHaveBeenCalledWith("/api/voice/synthesize", {
      method: "POST",
      body: JSON.stringify({ text: "先看这个圆。" }),
      signal: controller.signal,
    });
  });
});
