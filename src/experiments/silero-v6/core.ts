export const SILERO_SAMPLE_RATE = 16_000;
export const SILERO_FRAME_SAMPLES = 512;
export const SILERO_FRAME_MS =
  (SILERO_FRAME_SAMPLES / SILERO_SAMPLE_RATE) * 1_000;

export type DetectionEventType =
  | "candidate_start"
  | "speech_confirmed"
  | "speech_end"
  | "misfire";

export type DetectionEvent = {
  type: DetectionEventType;
  frameIndex: number;
  atMs: number;
};

export type DetectionConfig = {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  redemptionMs: number;
};

export class FrameAssembler {
  private pending = new Float32Array(SILERO_FRAME_SAMPLES);
  private pendingLength = 0;

  push(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    let sourceOffset = 0;

    while (sourceOffset < samples.length) {
      const available = SILERO_FRAME_SAMPLES - this.pendingLength;
      const copyLength = Math.min(available, samples.length - sourceOffset);
      this.pending.set(
        samples.subarray(sourceOffset, sourceOffset + copyLength),
        this.pendingLength,
      );
      this.pendingLength += copyLength;
      sourceOffset += copyLength;

      if (this.pendingLength === SILERO_FRAME_SAMPLES) {
        frames.push(this.pending.slice());
        this.pendingLength = 0;
      }
    }

    return frames;
  }

  reset() {
    this.pendingLength = 0;
    this.pending.fill(0);
  }
}

export class DetectionTracker {
  private readonly config: DetectionConfig;
  private candidateStartFrame: number | null = null;
  private speechFrames = 0;
  private silenceFrames = 0;
  private confirmed = false;

  constructor(config: DetectionConfig) {
    this.config = config;
  }

  update(probability: number, frameIndex: number): DetectionEvent[] {
    const events: DetectionEvent[] = [];

    if (this.candidateStartFrame === null) {
      if (probability >= this.config.positiveSpeechThreshold) {
        this.candidateStartFrame = frameIndex;
        this.speechFrames = 1;
        events.push(this.event("candidate_start", frameIndex));
        this.confirmIfReady(frameIndex, events);
      }
      return events;
    }

    if (probability >= this.config.positiveSpeechThreshold) {
      this.speechFrames += 1;
      this.silenceFrames = 0;
      this.confirmIfReady(frameIndex, events);
      return events;
    }

    if (probability < this.config.negativeSpeechThreshold) {
      this.silenceFrames += 1;
      if (this.silenceFrames * SILERO_FRAME_MS >= this.config.redemptionMs) {
        events.push(
          this.event(this.confirmed ? "speech_end" : "misfire", frameIndex),
        );
        this.reset();
      }
    } else {
      this.silenceFrames = 0;
    }

    return events;
  }

  flush(frameIndex: number): DetectionEvent[] {
    if (this.candidateStartFrame === null) return [];
    const event = this.event(
      this.confirmed ? "speech_end" : "misfire",
      frameIndex,
    );
    this.reset();
    return [event];
  }

  reset() {
    this.candidateStartFrame = null;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.confirmed = false;
  }

  private confirmIfReady(frameIndex: number, events: DetectionEvent[]) {
    if (
      !this.confirmed &&
      this.speechFrames * SILERO_FRAME_MS >= this.config.minSpeechMs
    ) {
      this.confirmed = true;
      events.push(this.event("speech_confirmed", frameIndex));
    }
  }

  private event(type: DetectionEventType, frameIndex: number): DetectionEvent {
    return {
      type,
      frameIndex,
      atMs: frameIndex * SILERO_FRAME_MS,
    };
  }
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}

export function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
