/**
 * VAD presets shared by the production voice conversation and diagnostics.
 * Keeping the baseline preset here lets Voice Lab measure the same normal
 * listening behavior without importing the turn/Agent conversation module.
 */
export const LISTENING_VAD_OPTIONS = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  minSpeechMs: 220,
  redemptionMs: 700,
} as const;

export const THINKING_INTERRUPT_VAD_OPTIONS = {
  positiveSpeechThreshold: 0.75,
  negativeSpeechThreshold: 0.55,
  minSpeechMs: 700,
  redemptionMs: 650,
} as const;

export const SPEAKING_INTERRUPT_VAD_OPTIONS = {
  positiveSpeechThreshold: 0.68,
  negativeSpeechThreshold: 0.48,
  minSpeechMs: 620,
  redemptionMs: 700,
} as const;
