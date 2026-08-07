import { describe, expect, it } from "vitest";
import {
  summarizeVoiceReadiness,
  type OminixRuntimeSummary,
} from "./use-ominix-runtime-summary";
import type { VoiceReadiness } from "@/settings/settings-api";

function readiness(overrides: Partial<VoiceReadiness> = {}): VoiceReadiness {
  return {
    ready: true,
    asr: { ready: true, mode: "ominix", detail: "OMiniX ASR ready" },
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

  it("offers OMiniX settings when the OMiniX ASR route is not ready", () => {
    const summary = summarizeVoiceReadiness(
      readiness({
        ready: false,
        asr: {
          ready: false,
          mode: "ominix",
          detail: "OMiniX ASR model not ready",
        },
        // Even with a downstream TTS failure, ASR is reported first.
        tts: {
          ready: false,
          mode: "local",
          detail: "No on-device voice available",
        },
      }),
    );
    expect(stripRefresh(summary)).toMatchObject({
      label: "OMiniX ASR model not ready",
      tone: "warning",
      ready: false,
      canRepair: true,
      state: "asr_not_ready",
      settingsPath: "/settings?tab=ominix",
      actionLabel: "打开 OMiniX 设置",
    });
  });

  it("does not offer OMiniX repair when the external ASR route is unavailable", () => {
    const summary = summarizeVoiceReadiness(
      readiness({
        ready: false,
        asr: {
          ready: false,
          mode: "external",
          detail: "External ASR is unreachable",
        },
      }),
    );
    expect(stripRefresh(summary)).toMatchObject({
      label: "External ASR is unreachable",
      canRepair: false,
      state: "asr_not_ready_external",
      settingsPath: null,
      actionLabel: null,
      guidance: "请检查 ASR_API_URL 指向的语音识别服务。",
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
      settingsPath: "/settings?tab=llm",
      actionLabel: "打开 LLM 设置",
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
      settingsPath: "/settings?tab=voice",
      actionLabel: "打开语音设置",
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
      settingsPath: "/settings?tab=ominix",
      actionLabel: "打开 OMiniX 设置",
    });
  });
});
