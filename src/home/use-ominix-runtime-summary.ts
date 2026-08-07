import { useEffect, useState } from "react";
import {
  fetchVoiceReadiness,
  type VoiceReadiness,
} from "@/settings/settings-api";

export type OminixRuntimeTone = "default" | "success" | "warning" | "danger";

export interface OminixRuntimeSummary {
  label: string;
  tone: OminixRuntimeTone;
  ready: boolean;
  loading: boolean;
  canRepair: boolean;
  state: string;
  settingsPath: string | null;
  actionLabel: string | null;
  guidance: string;
  /**
   * Whether the UI should surface the voice status at all. Only a problem
   * state (`warning`/`danger`) warrants a notification — a ready engine is
   * used silently, and the transient "checking" state stays quiet too. UI
   * surfaces should render the status label only when this is true.
   */
  needsAttention: boolean;
  refresh: () => Promise<void>;
}

type OminixRuntimeSnapshot = Omit<
  OminixRuntimeSummary,
  "refresh" | "needsAttention"
>;

const POLL_MS = 10_000;

const INITIAL_SUMMARY: OminixRuntimeSnapshot = {
  label: "Checking voice engine",
  tone: "default",
  ready: false,
  loading: true,
  canRepair: false,
  state: "checking",
  settingsPath: null,
  actionLabel: null,
  guidance: "",
};

let cachedSummary: OminixRuntimeSnapshot = INITIAL_SUMMARY;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(summary: OminixRuntimeSnapshot) => void>();

function emit(summary: OminixRuntimeSnapshot) {
  cachedSummary = summary;
  listeners.forEach((listener) => listener(summary));
}

/**
 * Collapse the three-leg pipeline readiness into the UI snapshot. The check
 * confirms the WHOLE voice path is usable under the caller's current config —
 * ASR, LLM, and TTS are each validated against their effective route. When a
 * leg blocks, the summary points to the settings surface that owns that route.
 */
export function summarizeVoiceReadiness(
  readiness: VoiceReadiness,
): OminixRuntimeSnapshot {
  if (readiness.ready) {
    return {
      label: "Voice engine ready",
      tone: "success",
      ready: true,
      loading: false,
      canRepair: false,
      state: "ready",
      settingsPath: null,
      actionLabel: null,
      guidance: "",
    };
  }

  // Report the first failing leg, in pipeline order: ASR → LLM → TTS.
  if (!readiness.asr.ready) {
    if (readiness.asr.mode === "external") {
      return {
        label: readiness.asr.detail,
        tone: "warning",
        ready: false,
        loading: false,
        canRepair: false,
        state: "asr_not_ready_external",
        settingsPath: null,
        actionLabel: null,
        guidance: "请检查 ASR_API_URL 指向的语音识别服务。",
      };
    }
    return {
      label: readiness.asr.detail,
      tone: "warning",
      ready: false,
      loading: false,
      canRepair: true,
      state: "asr_not_ready",
      settingsPath: "/settings?tab=ominix",
      actionLabel: "打开 OMiniX 设置",
      guidance: "语音引擎未就绪，请安装或修复 OMiniX。",
    };
  }

  if (!readiness.llm.ready) {
    return {
      label: readiness.llm.detail,
      tone: "warning",
      ready: false,
      loading: false,
      canRepair: false,
      state: "llm_not_ready",
      settingsPath: "/settings?tab=llm",
      actionLabel: "打开 LLM 设置",
      guidance: "请先配置可用的 LLM 服务。",
    };
  }

  const localTts = readiness.tts.mode === "local";
  return {
    label: readiness.tts.detail,
    tone: "warning",
    ready: false,
    loading: false,
    canRepair: localTts,
    state: `tts_not_ready_${readiness.tts.mode}`,
    settingsPath: localTts ? "/settings?tab=ominix" : "/settings?tab=voice",
    actionLabel: localTts ? "打开 OMiniX 设置" : "打开语音设置",
    guidance: localTts
      ? "本地语音合成尚未就绪，请检查 OMiniX。"
      : "请检查云端语音合成配置。",
  };
}

export function refreshOminixRuntimeSummary(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetchVoiceReadiness()
    .then((readiness) => {
      emit(summarizeVoiceReadiness(readiness));
    })
    .catch(() => {
      emit({
        label: "Voice engine check unavailable",
        tone: "warning",
        ready: false,
        loading: false,
        canRepair: false,
        state: "unknown",
        settingsPath: null,
        actionLabel: null,
        guidance: "无法检查语音服务状态，请稍后重试。",
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useOminixRuntimeSummary(enabled = true) {
  const [summary, setSummary] = useState<OminixRuntimeSnapshot>(cachedSummary);

  useEffect(() => {
    if (!enabled) return;
    listeners.add(setSummary);
    void refreshOminixRuntimeSummary();
    const timer = window.setInterval(() => {
      void refreshOminixRuntimeSummary();
    }, POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshOminixRuntimeSummary();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      listeners.delete(setSummary);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled]);

  return {
    ...summary,
    needsAttention: summary.tone === "warning" || summary.tone === "danger",
    refresh: refreshOminixRuntimeSummary,
  };
}
