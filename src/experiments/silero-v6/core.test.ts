import { describe, expect, it } from "vitest";
import {
  DetectionTracker,
  FrameAssembler,
  SILERO_FRAME_MS,
  SILERO_FRAME_SAMPLES,
  average,
  percentile,
} from "./core";

describe("Silero v6 browser experiment core", () => {
  it("assembles arbitrary worklet chunks into exact 512-sample frames", () => {
    const assembler = new FrameAssembler();
    const first = assembler.push(new Float32Array(300).fill(1));
    const second = assembler.push(new Float32Array(800).fill(2));

    expect(first).toEqual([]);
    expect(second).toHaveLength(2);
    expect(second[0]).toHaveLength(SILERO_FRAME_SAMPLES);
    expect(second[0]?.[299]).toBe(1);
    expect(second[0]?.[300]).toBe(2);
    expect(second[1]?.every((sample) => sample === 2)).toBe(true);
  });

  it("confirms sustained speech and ends it after the redemption window", () => {
    const tracker = new DetectionTracker({
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.4,
      minSpeechMs: SILERO_FRAME_MS * 3,
      redemptionMs: SILERO_FRAME_MS * 2,
    });

    expect(tracker.update(0.7, 0).map((event) => event.type)).toEqual([
      "candidate_start",
    ]);
    expect(tracker.update(0.8, 1)).toEqual([]);
    expect(tracker.update(0.9, 2).map((event) => event.type)).toEqual([
      "speech_confirmed",
    ]);
    expect(tracker.update(0.2, 3)).toEqual([]);
    expect(tracker.update(0.2, 4).map((event) => event.type)).toEqual([
      "speech_end",
    ]);
  });

  it("reports a short noise burst as a misfire", () => {
    const tracker = new DetectionTracker({
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.4,
      minSpeechMs: SILERO_FRAME_MS * 3,
      redemptionMs: SILERO_FRAME_MS,
    });

    tracker.update(0.9, 0);
    expect(tracker.update(0.1, 1).map((event) => event.type)).toEqual([
      "misfire",
    ]);
  });

  it("calculates stable average and percentile summaries", () => {
    expect(average([1, 2, 3])).toBe(2);
    expect(average([])).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([], 0.95)).toBe(0);
  });
});
