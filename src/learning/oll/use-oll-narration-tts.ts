import { useEffect, useRef, useState } from "react";

export interface OllNarrationTtsOptions {
  enabled: boolean;
  playing: boolean;
  text: string;
  language: string;
}

export interface OllNarrationTtsState {
  error: string | null;
}

/**
 * Speaks OLL narration without acquiring a microphone.
 *
 * Text input and teacher output are independent product capabilities. This
 * hook intentionally consumes the Runtime's current narration rather than
 * assistant chat text, so board actions, the teacher bubble, and speech stay on
 * the same Beat.
 */
export function useOllNarrationTts({
  enabled,
  playing,
  text,
  language,
}: OllNarrationTtsOptions): OllNarrationTtsState {
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [failure, setFailure] = useState<{
    text: string;
    message: string;
  } | null>(null);
  const normalizedText = text.trim();
  const speech =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    window.speechSynthesis;
  const supported =
    Boolean(speech) &&
    typeof SpeechSynthesisUtterance !== "undefined";

  useEffect(() => {
    if (!enabled || !playing || !normalizedText) {
      const hadUtterance = Boolean(utteranceRef.current);
      utteranceRef.current = null;
      if (hadUtterance && speech) speech.cancel();
      return;
    }

    if (!supported || !speech) return;

    speech.cancel();
    const utterance = new SpeechSynthesisUtterance(normalizedText);
    utterance.lang = language || "zh-CN";
    utterance.onend = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
      }
    };
    utterance.onerror = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setFailure({
        text: normalizedText,
        message: "课程语音暂时不可用，旁白仍会显示。",
      });
    };
    utteranceRef.current = utterance;
    speech.speak(utterance);

    return () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
        speech.cancel();
      }
    };
  }, [enabled, language, normalizedText, playing, speech, supported]);

  useEffect(
    () => () => {
      if (
        utteranceRef.current &&
        typeof window !== "undefined" &&
        "speechSynthesis" in window
      ) {
        utteranceRef.current = null;
        window.speechSynthesis.cancel();
      }
    },
    [],
  );

  if (!enabled || !playing || !normalizedText) return { error: null };
  if (!supported) {
    return { error: "当前浏览器不支持课程语音，旁白仍会显示。" };
  }
  return {
    error: failure?.text === normalizedText ? failure.message : null,
  };
}
