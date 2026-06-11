import { describe, it, expect } from "vitest";
import { pickFreshAudio } from "./use-voice-conversation";

describe("pickFreshAudio", () => {
  it("returns latest unplayed assistant audio file", () => {
    const threads = [
      { responses: [{ role: "assistant", text: "hi", files: [{ path: "a/r1.wav" }] }] },
      { responses: [{ role: "assistant", text: "yo", files: [{ path: "a/r2.wav" }] }] },
    ] as any;
    const got = pickFreshAudio(threads, new Set(["a/r1.wav"]));
    expect(got).toEqual({ path: "a/r2.wav", text: "yo" });
  });
  it("returns null when all audio already played", () => {
    const threads = [
      { responses: [{ role: "assistant", text: "hi", files: [{ path: "a/r1.wav" }] }] },
    ] as any;
    expect(pickFreshAudio(threads, new Set(["a/r1.wav"]))).toBeNull();
  });
});
