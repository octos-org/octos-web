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
 * ASR (always on-device), LLM, and TTS validated per its effective route
 * (cloud credentials for Volcano, or the on-device GPT-SoVITS engine). When a
 * leg blocks, its `detail` becomes the label so the UI names the exact gap
 * instead of a generic "models not ready".
 *
 * `canRepair` is true only for on-device-engine gaps (ASR model / local TTS),
 * which the OMiniX repair flow can fix; LLM and cloud-credential gaps are a
 * settings task, not a repair, so they report `canRepair: false`.
 */
export function summarizeVoiceReadiness(readiness: VoiceReadiness): OminixRuntimeSnapshot {
  if (readiness.ready) {
    return {
      label: "Voice engine ready",
      tone: "success",
      ready: true,
      loading: false,
      canRepair: false,
      state: "ready",
    };
  }

  // Report the first failing leg, in pipeline order: ASR → LLM → TTS.
  if (!readiness.asr.ready) {
    return {
      label: readiness.asr.detail,
      tone: "warning",
      ready: false,
      loading: false,
      canRepair: true,
      state: "asr_not_ready",
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
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useOminixRuntimeSummary() {
  const [summary, setSummary] = useState<OminixRuntimeSnapshot>(cachedSummary);

  useEffect(() => {
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
  }, []);

  return {
    ...summary,
    needsAttention: summary.tone === "warning" || summary.tone === "danger",
    refresh: refreshOminixRuntimeSummary,
  };
}
