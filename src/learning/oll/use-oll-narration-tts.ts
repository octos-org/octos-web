import { useEffect, useState } from "react";
import { synthesizeSpeech } from "@/api/voice";
import {
  playAudioBlob,
  stopAudio,
} from "@/home/voice/audio-playback";
import { traceLearnDiagnostic } from "../learn-diagnostics";

export interface OllNarrationTtsOptions {
  sessionId?: string;
  enabled: boolean;
  playing: boolean;
  text: string;
  narrationId?: string;
  onSpeakingChange?: (speaking: boolean) => void;
  onPlaybackComplete?: (narrationId: string) => void;
}

export interface OllNarrationTtsState {
  error: string | null;
}

/**
 * Plays the Runtime's current narration through the profile's system TTS.
 *
 * The hook knows nothing about the learner's input mode. Text and voice input
 * therefore share this exact synthesis, cancellation, and playback path.
 */
export function useOllNarrationTts({
  sessionId,
  enabled,
  playing,
  text,
  narrationId,
  onSpeakingChange,
  onPlaybackComplete,
}: OllNarrationTtsOptions): OllNarrationTtsState {
  const normalizedText = text.trim();
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const request = new AbortController();
    let current = true;
    let completed = false;
    const completePlayback = () => {
      if (!current || completed || !narrationId) return;
      completed = true;
      traceLearnDiagnostic("tts.playback_completed", {
        sessionId,
        narrationId,
      });
      onPlaybackComplete?.(narrationId);
    };

    if (!enabled || !playing || !normalizedText) {
      onSpeakingChange?.(false);
      stopAudio();
      if (!enabled && playing && normalizedText) completePlayback();
      return () => {
        current = false;
        request.abort();
      };
    }

    traceLearnDiagnostic("tts.request_started", {
      sessionId,
      narrationId: narrationId ?? null,
      textLength: normalizedText.length,
    });
    void synthesizeSpeech(normalizedText, request.signal)
      .then(async (audio) => {
        if (!current || request.signal.aborted) return;
        traceLearnDiagnostic("tts.synthesis_succeeded", {
          sessionId,
          narrationId: narrationId ?? null,
          audioBytes: audio.size,
          audioType: audio.type,
        });
        setFailure(null);
        onSpeakingChange?.(true);
        const started = await playAudioBlob(
          audio,
          () => {
            if (!current) return;
            onSpeakingChange?.(false);
            completePlayback();
          },
          request.signal,
        );
        traceLearnDiagnostic(
          started ? "tts.playback_started" : "tts.playback_rejected",
          {
            sessionId,
            narrationId: narrationId ?? null,
          },
        );
        if (!started && current) {
          onSpeakingChange?.(false);
          setFailure("当前设备无法播放课程语音，旁白仍会显示。");
          completePlayback();
        }
      })
      .catch((cause: unknown) => {
        if (
          !current ||
          request.signal.aborted ||
          (cause instanceof DOMException && cause.name === "AbortError")
        ) {
          return;
        }
        onSpeakingChange?.(false);
        traceLearnDiagnostic("tts.request_failed", {
          sessionId,
          narrationId: narrationId ?? null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        setFailure("课程语音暂时不可用，旁白仍会显示。");
        completePlayback();
      });

    return () => {
      if (!completed) {
        traceLearnDiagnostic("tts.cancelled", {
          sessionId,
          narrationId: narrationId ?? null,
          willAbortRequest: !request.signal.aborted,
        });
      }
      current = false;
      request.abort();
      onSpeakingChange?.(false);
      stopAudio();
    };
  }, [
    enabled,
    narrationId,
    normalizedText,
    onPlaybackComplete,
    onSpeakingChange,
    playing,
    sessionId,
  ]);

  return {
    error: enabled ? failure : null,
  };
}
