export const TARGET_SAMPLE_RATE = 16_000;
export const FRAME_COUNT = 98;
export const MEL_BINS = 32;
export const FRAME_LENGTH = 400;
export const HOP_LENGTH = 160;
export const MODEL_AUDIO_WINDOW_SAMPLES = FRAME_COUNT * HOP_LENGTH + FRAME_LENGTH;
export const MAX_WAKE_AUDIO_SAMPLES = TARGET_SAMPLE_RATE * 3;

export interface SampleSummary {
  rms: number;
  peak: number;
}

export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate = TARGET_SAMPLE_RATE,
): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const weight = position - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }

  return output;
}

export function appendSamples(
  existing: Float32Array,
  incoming: Float32Array,
  maxSamples: number,
): Float32Array {
  const total = existing.length + incoming.length;
  const outputLength = Math.min(maxSamples, total);
  const output = new Float32Array(outputLength);
  const fromExisting = Math.max(0, outputLength - incoming.length);

  if (fromExisting > 0) {
    output.set(existing.slice(existing.length - fromExisting), 0);
  }
  output.set(incoming.slice(Math.max(0, incoming.length - outputLength)), fromExisting);
  return output;
}

export function summarizeSamples(samples: Float32Array): SampleSummary {
  if (samples.length === 0) return { rms: 0, peak: 0 };

  let sumSquares = 0;
  let peak = 0;
  for (const value of samples) {
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }

  return {
    rms: Math.sqrt(sumSquares / samples.length),
    peak,
  };
}

export function isWakeWordOriginAllowed(
  hostname = globalThis.location?.hostname ?? "",
  secure = globalThis.isSecureContext === true,
): boolean {
  return (
    secure ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.")
  );
}
