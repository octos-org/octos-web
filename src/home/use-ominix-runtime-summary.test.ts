import { describe, expect, it } from "vitest";
import {
  summarizeVoiceReadiness,
  type OminixRuntimeSummary,
} from "./use-ominix-runtime-summary";
import type { VoiceReadiness } from "@/settings/settings-api";

function readiness(overrides: Partial<VoiceReadiness> = {}): VoiceReadiness {
  return {
    ready: true,
    asr: { ready: true, detail: "On-device ASR ready" },
    llm: { ready: true, detail: "LLM provider: openai" },
    tts: { ready: true, mode: "local", detail: "On-device GPT-SoVITS ready" },
    ...overrides,
  };
}

function stripRefresh(summary: Omit<OminixRuntimeSummary, "refresh">) {
  return summary;
}

describe("summarizeVoiceReadiness", () => {
  it("marks a fully-ready pipeline as ready", () => {
    expect(stripRefresh(summarizeVoiceReadiness(readiness()))).toMatchObject({
      label: "Voice engine ready",
      tone: "success",
      ready: true,
      loading: false,
    });
  });

  it("blocks on ASR first and offers repair (ASR is always on-device)", () => {
    const summary = summarizeVoiceReadiness(
      readiness({
        ready: false,
        asr: { ready: false, detail: "On-device ASR model not ready" },
        // Even with a downstream TTS failure, ASR is reported first.
        tts: { ready: false, mode: "local", detail: "No on-device voice available" },
      }),
    );
    expect(stripRefresh(summary)).toMatchObject({
      label: "On-device ASR model not ready",
      tone: "warning",
      ready: false,
      canRepair: true,
      state: "asr_not_ready",
    });
  });

  it("blocks on LLM with no repair affordance (configure, not repair)", () => {
    const summary = summarizeVoiceReadiness(
      readiness({
        ready: false,
        llm: { ready: false, detail: "LLM provider not configured" },
      }),
    );
    expect(stripRefresh(summary)).toMatchObject({
      label: "LLM provider not configured",
      tone: "warning",
      ready: false,
      canRepair: false,
      state: "llm_not_ready",
    });
  });

  it("flags missing cloud TTS credentials without offering repair", () => {
    const summary = summarizeVoiceReadiness(
      readiness({
        ready: false,
        tts: {
          ready: false,
          mode: "cloud",
          detail: "Cloud TTS selected but credentials missing (appid + VOLC_TTS_TOKEN)",
        },
      }),
    );
    expect(stripRefresh(summary)).toMatchObject({
      label: "Cloud TTS selected but credentials missing (appid + VOLC_TTS_TOKEN)",
      tone: "warning",
      ready: false,
      canRepair: false,
      state: "tts_not_ready_cloud",
    });
  });

  it("offers repair when the on-device TTS engine is the gap", () => {
    const summary = summarizeVoiceReadiness(
      readiness({
        ready: false,
        tts: { ready: false, mode: "local", detail: "No on-device voice available" },
      }),
    );
    expect(stripRefresh(summary)).toMatchObject({
      label: "No on-device voice available",
      ready: false,
      canRepair: true,
      state: "tts_not_ready_local",
    });
  });
});
