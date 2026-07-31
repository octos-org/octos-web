import { useEffect, useState } from "react";
import { synthesizeSpeech } from "@/api/voice";
import {
  playAudioBlob,
  stopAudio,
} from "@/home/voice/audio-playback";

export interface OllNarrationTtsOptions {
  enabled: boolean;
  playing: boolean;
  text: string;
  onSpeakingChange?: (speaking: boolean) => void;
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
  enabled,
  playing,
  text,
  onSpeakingChange,
}: OllNarrationTtsOptions): OllNarrationTtsState {
  const normalizedText = text.trim();
  const [failure, setFailure] = useState<{
    text: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    const request = new AbortController();
    let current = true;

    if (!enabled || !playing || !normalizedText) {
      onSpeakingChange?.(false);
      stopAudio();
      return () => {
        current = false;
        request.abort();
      };
    }

    void synthesizeSpeech(normalizedText, request.signal)
      .then(async (audio) => {
        if (!current || request.signal.aborted) return;
        setFailure(null);
        onSpeakingChange?.(true);
        const started = await playAudioBlob(
          audio,
          () => {
            if (current) onSpeakingChange?.(false);
          },
          request.signal,
        );
        if (!started && current) {
          onSpeakingChange?.(false);
          setFailure({
            text: normalizedText,
            message: "当前设备无法播放课程语音，旁白仍会显示。",
          });
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
        setFailure({
          text: normalizedText,
          message: "课程语音暂时不可用，旁白仍会显示。",
        });
      });

    return () => {
      current = false;
      request.abort();
      onSpeakingChange?.(false);
      stopAudio();
    };
  }, [enabled, normalizedText, onSpeakingChange, playing]);

  return {
    error:
      enabled && playing && failure?.text === normalizedText
        ? failure.message
        : null,
  };
}
