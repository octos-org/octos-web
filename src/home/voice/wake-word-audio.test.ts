import { describe, expect, it } from "vitest";
import {
  appendSamples,
  isWakeWordOriginAllowed,
  resampleLinear,
  summarizeSamples,
} from "./wake-word-audio";
import { describeWakeWordListener } from "./use-wake-word-listener";

describe("wake-word audio helpers", () => {
  it("keeps the newest samples when appending beyond the cap", () => {
    const out = appendSamples(
      new Float32Array([1, 2, 3]),
      new Float32Array([4, 5, 6]),
      4,
    );

    expect(Array.from(out)).toEqual([3, 4, 5, 6]);
  });

  it("resamples linearly", () => {
    const out = resampleLinear(new Float32Array([0, 1, 0, -1]), 4, 2);

    expect(Array.from(out)).toEqual([0, 0]);
  });

  it("summarizes rms and peak", () => {
    const summary = summarizeSamples(new Float32Array([0.5, -1, 0]));

    expect(summary.peak).toBe(1);
    expect(summary.rms).toBeGreaterThan(0.6);
  });

  it("allows localhost, lan, and secure origins", () => {
    expect(isWakeWordOriginAllowed("127.0.0.1", false)).toBe(true);
    expect(isWakeWordOriginAllowed("192.168.1.3", false)).toBe(true);
    expect(isWakeWordOriginAllowed("example.com", true)).toBe(true);
    expect(isWakeWordOriginAllowed("example.com", false)).toBe(false);
  });
});

describe("wake-word status label", () => {
  it("uses the trained wake phrase while listening", () => {
    expect(
      describeWakeWordListener("listening", "你好小章鱼").label,
    ).toBe("说「你好小章鱼」");
  });
});
