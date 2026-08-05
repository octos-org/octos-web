import { describe, expect, it } from "vitest";
import {
  VOICE_LAB_METRICS,
  VOICE_LAB_SCENARIOS,
  createVoiceLabLabel,
} from "./voice-lab-data";

describe("Voice Lab acceptance data", () => {
  it("includes every agreed speech and non-speech acceptance scenario", () => {
    expect(VOICE_LAB_SCENARIOS.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        "normal-chinese",
        "short-command",
        "quiet-far-whisper",
        "speech-with-keyboard",
        "tts-double-talk",
        "single-keypress",
        "continuous-typing",
        "impact-and-door",
        "ambient-noise",
        "music",
        "tts-only",
        "non-linguistic-human-sound",
      ]),
    );
    expect(VOICE_LAB_METRICS.map((metric) => metric.id)).toEqual(
      expect.arrayContaining([
        "normal-speech-recall",
        "short-phrase-recall",
        "non-speech-candidate-rate",
        "speech-boundary-truncation",
        "vad-start-latency",
        "vad-end-latency",
        "asr-non-speech-hallucination-rate",
        "asr-speech-empty-text-rate",
        "speech-to-formal-input-latency",
      ]),
    );
  });

  it("creates an intentionally unlabeled, structured recording label", () => {
    expect(createVoiceLabLabel()).toEqual({
      containsSpeech: null,
      expectedText: "",
      scenario: "normal-chinese",
      notes: "",
    });
  });
});
