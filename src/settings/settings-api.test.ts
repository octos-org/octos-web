import { describe, expect, it } from "vitest";
import { mergeProfileConfig, normalizeProfileConfig } from "./settings-api";

describe("mergeProfileConfig — voice TTS fields", () => {
  it("should carry tts_provider and tts_cloud through a patch", () => {
    const current = normalizeProfileConfig({});
    const next = mergeProfileConfig(current, {
      tts_provider: "cloud",
      tts_cloud: { appid: "999", voice: "BV700" },
    });
    expect(next.tts_provider).toBe("cloud");
    expect(next.tts_cloud).toEqual({ appid: "999", voice: "BV700" });
  });

  it("should default tts fields to undefined when absent", () => {
    const cfg = normalizeProfileConfig({});
    expect(cfg.tts_provider).toBeUndefined();
    expect(cfg.tts_cloud ?? undefined).toBeUndefined();
  });
});
