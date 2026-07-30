import { describe, expect, it } from "vitest";
import { ollPlaybackStorageKey } from "./oll-playback-storage";

describe("OLL playback storage", () => {
  it("versions checkpoints when canonical event semantics change", () => {
    expect(ollPlaybackStorageKey("learn-1", undefined)).toBe(
      "octos-learning-oll:v4:learn-1:none",
    );
    expect(ollPlaybackStorageKey("learn-1", "geometry-v2")).toBe(
      "octos-learning-oll:v4:learn-1:geometry-v2",
    );
  });
});
