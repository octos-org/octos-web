import { describe, it, expect, vi } from "vitest";
import {
  assembleTurnFiles,
  collectFreshAudio,
  pickFreshAudio,
} from "./use-voice-conversation";
import type { Thread } from "@/store/thread-store";

describe("assembleTurnFiles", () => {
  const audio = new File(["a"], "utterance.wav", { type: "audio/wav" });
  const frame = new File(["f"], "frame.jpg", { type: "image/jpeg" });

  it("sends audio only when the camera is disabled", async () => {
    const grab = vi.fn();
    const files = await assembleTurnFiles(audio, false, grab);
    expect(files).toEqual([audio]);
    expect(grab).not.toHaveBeenCalled();
  });

  it("appends the frame when the camera is enabled", async () => {
    const grab = vi.fn().mockResolvedValue(frame);
    const files = await assembleTurnFiles(audio, true, grab);
    expect(files).toEqual([audio, frame]);
  });

  it("falls back to audio only when grabFrame returns null", async () => {
    const grab = vi.fn().mockResolvedValue(null);
    const files = await assembleTurnFiles(audio, true, grab);
    expect(files).toEqual([audio]);
  });
});

describe("pickFreshAudio", () => {
  it("returns latest unplayed assistant audio file", () => {
    const threads = [
      { responses: [{ role: "assistant", text: "hi", files: [{ path: "a/r1.wav" }] }] },
      { responses: [{ role: "assistant", text: "yo", files: [{ path: "a/r2.wav" }] }] },
    ] as unknown as Thread[];
    const got = pickFreshAudio(threads, new Set(["a/r1.wav"]));
    expect(got).toEqual({ path: "a/r2.wav", text: "yo" });
  });
  it("returns null when all audio already played", () => {
    const threads = [
      { responses: [{ role: "assistant", text: "hi", files: [{ path: "a/r1.wav" }] }] },
    ] as unknown as Thread[];
    expect(pickFreshAudio(threads, new Set(["a/r1.wav"]))).toBeNull();
  });

  it("can skip audio from interrupted turns", () => {
    const threads = [
      {
        id: "old-turn",
        responses: [
          { role: "assistant", text: "old", files: [{ path: "a/old.wav" }] },
        ],
      },
      {
        id: "new-turn",
        responses: [
          { role: "assistant", text: "new", files: [{ path: "a/new.wav" }] },
        ],
      },
    ] as unknown as Thread[];

    expect(collectFreshAudio(threads, new Set(), new Set(["old-turn"]))).toEqual([
      { path: "a/new.wav", text: "new" },
    ]);
  });
});
