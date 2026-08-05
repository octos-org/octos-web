/**
 * Machine-readable acceptance catalogue for the voice-input project. These
 * records are deliberately independent of a detector or ASR implementation so
 * later baseline runs can compare models against exactly the same labels.
 */
export type VoiceLabScenarioId =
  | "normal-chinese"
  | "short-command"
  | "quiet-far-whisper"
  | "speech-with-keyboard"
  | "tts-double-talk"
  | "single-keypress"
  | "continuous-typing"
  | "impact-and-door"
  | "ambient-noise"
  | "music"
  | "tts-only"
  | "non-linguistic-human-sound";

export interface VoiceLabScenario {
  id: VoiceLabScenarioId;
  label: string;
  containsSpeech: boolean;
  description: string;
}

export const VOICE_LAB_SCENARIOS: readonly VoiceLabScenario[] = [
  { id: "normal-chinese", label: "正常中文语音", containsSpeech: true, description: "自然说话。" },
  { id: "short-command", label: "短句（你好／停／继续）", containsSpeech: true, description: "1–4 字语言语音。" },
  { id: "quiet-far-whisper", label: "低音量／远场／耳语", containsSpeech: true, description: "困难但有效的语言语音。" },
  { id: "speech-with-keyboard", label: "说话同时键盘声", containsSpeech: true, description: "语言语音和键盘同时存在。" },
  { id: "tts-double-talk", label: "TTS 播放时用户插话", containsSpeech: true, description: "双讲场景中的用户语言语音。" },
  { id: "single-keypress", label: "单次键盘敲击", containsSpeech: false, description: "不应形成语言输入。" },
  { id: "continuous-typing", label: "连续打字", containsSpeech: false, description: "不应形成语言输入。" },
  { id: "impact-and-door", label: "鼠标／敲桌／开关门", containsSpeech: false, description: "冲击与机械声音。" },
  { id: "ambient-noise", label: "风扇和环境噪声", containsSpeech: false, description: "持续环境声音。" },
  { id: "music", label: "音乐", containsSpeech: false, description: "不应形成语言输入。" },
  { id: "tts-only", label: "只有 Octos TTS", containsSpeech: false, description: "用户未说话时的播放残留。" },
  { id: "non-linguistic-human-sound", label: "咳嗽／呼吸／笑声", containsSpeech: false, description: "非语言的人体声音。" },
];

export type VoiceLabMetricId =
  | "normal-speech-recall"
  | "short-phrase-recall"
  | "non-speech-candidate-rate"
  | "speech-boundary-truncation"
  | "vad-start-latency"
  | "vad-end-latency"
  | "asr-non-speech-hallucination-rate"
  | "asr-speech-empty-text-rate"
  | "speech-to-formal-input-latency";

export interface VoiceLabMetric {
  id: VoiceLabMetricId;
  label: string;
  stage: "vad" | "asr" | "end-to-end";
}

export const VOICE_LAB_METRICS: readonly VoiceLabMetric[] = [
  { id: "normal-speech-recall", label: "正常语音召回率", stage: "vad" },
  { id: "short-phrase-recall", label: "短句召回率", stage: "vad" },
  { id: "non-speech-candidate-rate", label: "非语音 candidate 产生率", stage: "vad" },
  { id: "speech-boundary-truncation", label: "语音首尾截断", stage: "vad" },
  { id: "vad-start-latency", label: "VAD 开始延迟", stage: "vad" },
  { id: "vad-end-latency", label: "VAD 结束延迟", stage: "vad" },
  { id: "asr-non-speech-hallucination-rate", label: "ASR 非语音幻觉率", stage: "asr" },
  { id: "asr-speech-empty-text-rate", label: "ASR 真人语音空文本率", stage: "asr" },
  { id: "speech-to-formal-input-latency", label: "说完到正式输入总延迟", stage: "end-to-end" },
];

export interface VoiceLabLabel {
  containsSpeech: boolean | null;
  expectedText: string;
  scenario: VoiceLabScenarioId;
  notes: string;
}

export function createVoiceLabLabel(): VoiceLabLabel {
  return {
    containsSpeech: null,
    expectedText: "",
    scenario: "normal-chinese",
    notes: "",
  };
}

export function wavDurationMs(size: number, sampleRate = 16000): number {
  return Math.max(0, ((size - 44) / (sampleRate * 2)) * 1000);
}
