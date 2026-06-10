/**
 * useVoiceInput — Web Speech API hook for voice recognition.
 *
 * Wraps `SpeechRecognition` / `webkitSpeechRecognition` with graceful
 * degradation for unsupported browsers (Firefox, older mobile).
 *
 * State machine: idle → listening → processing → idle
 * The `speaking` state is set externally (when TTS / AI response plays).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrbState } from "./voice-orb";

/* ── Extend Window for webkitSpeechRecognition ────────── */
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onspeechend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as SpeechRecognitionCtor | undefined) ??
    (w.webkitSpeechRecognition as SpeechRecognitionCtor | undefined) ??
    null
  );
}

/* ── Public interface ─────────────────────────────────── */
export interface VoiceInputState {
  orbState: OrbState;
  isSupported: boolean;
  start: () => void;
  stop: () => void;
  transcript: string;
  /** Externally set the orb to `speaking` state. */
  setSpeaking: (speaking: boolean) => void;
}

export interface VoiceInputOptions {
  onResult: (text: string) => void;
  onSpeakingDone?: () => void;
  lang?: string;
}

/** Silence timeout — auto-stop after 10 s of no speech. */
const SILENCE_TIMEOUT = 10_000;

export function useVoiceInput(options: VoiceInputOptions): VoiceInputState {
  const { onResult, lang = "en-US" } = options;
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [transcript, setTranscript] = useState("");
  const [isSupported] = useState(() => getSpeechRecognition() !== null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /* ── Cleanup on unmount ──────────────────────────────── */
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  /* ── Start listening ─────────────────────────────────── */
  const start = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;

    // Abort any existing session
    recognitionRef.current?.abort();
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = lang;
    recognitionRef.current = rec;

    setOrbState("listening");
    setTranscript("");

    // Start silence timer
    silenceTimerRef.current = setTimeout(() => {
      rec.stop();
    }, SILENCE_TIMEOUT);

    rec.onresult = (event: SpeechRecognitionEvent) => {
      // Reset silence timer on any result
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        rec.stop();
      }, SILENCE_TIMEOUT);

      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }

      // Show interim text as transcript for visual feedback
      setTranscript(finalText || interimText);

      if (finalText) {
        setOrbState("processing");
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        optionsRef.current.onResult(finalText.trim());
      }
    };

    rec.onspeechend = () => {
      // Speech ended — transition to processing while waiting for final result
      if (orbState === "listening") {
        setOrbState("processing");
      }
    };

    rec.onerror = (_event: SpeechRecognitionErrorEvent) => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      recognitionRef.current = null;
      setOrbState("idle");
    };

    rec.onend = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      recognitionRef.current = null;
      // Only reset to idle if we're still in listening/processing
      // (don't override 'speaking' set externally)
      setOrbState((prev) => (prev === "speaking" ? prev : "idle"));
    };

    try {
      rec.start();
    } catch {
      setOrbState("idle");
      recognitionRef.current = null;
    }
  }, [lang, orbState]);

  /* ── Stop listening ──────────────────────────────────── */
  const stop = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    recognitionRef.current?.stop();
  }, []);

  /* ── External speaking control ───────────────────────── */
  const setSpeaking = useCallback((speaking: boolean) => {
    setOrbState(speaking ? "speaking" : "idle");
  }, []);

  return { orbState, isSupported, start, stop, transcript, setSpeaking };
}
