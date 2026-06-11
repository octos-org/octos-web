import { describe, it, expect } from "vitest";
import { encodeWav } from "./wav-encode";

describe("encodeWav", () => {
  it("produces a RIFF/WAVE header with correct sample rate and PCM data", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav(samples, 16000);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + samples.length * 2);
  });
  it("clamps out-of-range samples without throwing", () => {
    const samples = new Float32Array([2, -2]);
    expect(() => encodeWav(samples, 16000)).not.toThrow();
  });
});
