import { useCallback, useEffect, useRef, useState } from "react";
import { MicVAD } from "@ricky0123/vad-web";
import { encodeWav } from "./wav-encode";

export interface VoiceCapture {
  capturing: boolean;
  start: (
    onUtterance: (wav: Blob) => void,
    options?: VoiceCaptureStartOptions,
  ) => Promise<void>;
  /** Resolves once the VAD is fully torn down. Await before starting reply
   *  playback so the Silero ONNX/WASM + mic AudioContext shutdown doesn't
   *  contend with the playback render thread. */
  stop: () => Promise<void>;
  error: string | null;
}

export interface VoiceCaptureStartOptions {
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  minSpeechMs?: number;
  redemptionMs?: number;
  onSpeechRealStart?: () => void;
}

const VAD_SAMPLE_RATE = 16000;

// Self-hosted VAD assets (scripts/copy-vad-assets.mjs copies them into
// public/vad/). The library defaults baseAssetPath/onnxWASMBasePath to "./",
// which 404s, so we point them at /vad/.
//
// Two distinct loaders, two path forms:
//   - baseAssetPath: the worklet (audioWorklet.addModule) + Silero .onnx
//     (fetch). Root-relative "/vad/" is fine — these are not module imports.
//   - onnxWASMBasePath: onnxruntime-web loads its wasm GLUE via a dynamic
//     import() of "<base>ort-wasm-simd-threaded.mjs". Vite refuses to import()
//     a /public file via a root-relative specifier, so this MUST be an
//     absolute URL (origin-prefixed) — Vite leaves absolute http(s) imports
//     external and the browser fetches it from our own dev/prod server. Still
//     fully local (no CDN); origin adapts across dev port / prod host.
const VAD_BASE_ASSET_PATH = "/vad/";
const VAD_ONNX_WASM_BASE_PATH =
  typeof window !== "undefined"
    ? `${window.location.origin}/vad/`
    : "/vad/";
const noop = () => {};

export function useVoiceCapture(): VoiceCapture {
  const vadRef = useRef<MicVAD | null>(null);
  // Monotonic generation token. Every start()/stop() bumps it; an in-flight
  // async MicVAD.new() compares the generation it started under against the
  // current one and abandons (destroys) itself if a stop()/restart happened
  // meanwhile. This is what makes the hook safe under React StrictMode's
  // mount → unmount → remount double-invoke (and any rapid start/stop).
  const startGenRef = useRef(0);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback((): Promise<void> => {
    startGenRef.current++;
    const vad = vadRef.current;
    vadRef.current = null;
    setCapturing(false);
    if (!vad) return Promise.resolve();
    // Return a promise that resolves once teardown finishes so callers can
    // await it BEFORE starting reply playback — otherwise the ONNX/WASM + mic
    // AudioContext shutdown spikes CPU exactly as the reply's Web Audio render
    // thread starts, glitching the first sentence.
    return (async () => {
      try {
        await vad.pause();
      } catch {
        // already paused / destroyed
      }
      try {
        await vad.destroy();
      } catch {
        // already destroyed
      }
    })();
  }, []);

  const start = useCallback(async (
    onUtterance: (wav: Blob) => void,
    options: VoiceCaptureStartOptions = {},
  ) => {
    setError(null);
    const gen = ++startGenRef.current;
    const previous = vadRef.current;
    vadRef.current = null;
    if (previous) {
      void previous.pause();
      void previous.destroy();
    }
    try {
      const vad = await MicVAD.new({
        baseAssetPath: VAD_BASE_ASSET_PATH,
        onnxWASMBasePath: VAD_ONNX_WASM_BASE_PATH,
        // Less trigger-happy than the defaults so transient noise (keyboard
        // clicks, taps) doesn't register as speech and kick off a turn:
        //  - require a higher speech probability to START,
        //  - require ≥300ms of real speech before it counts as an utterance
        //    (short clicks fall under this and fire onVADMisfire instead),
        //  - wait ~700ms of silence before ending so natural pauses don't cut.
        positiveSpeechThreshold: options.positiveSpeechThreshold ?? 0.6,
        negativeSpeechThreshold: options.negativeSpeechThreshold ?? 0.4,
        minSpeechMs: options.minSpeechMs ?? 300,
        redemptionMs: options.redemptionMs ?? 700,
        onSpeechRealStart: () => {
          if (gen !== startGenRef.current) return;
          (options.onSpeechRealStart ?? noop)();
        },
        onSpeechEnd: (audio: Float32Array) => {
          if (gen !== startGenRef.current) return;
          onUtterance(encodeWav(audio, VAD_SAMPLE_RATE));
        },
      });
      if (gen !== startGenRef.current) {
        // A stop()/restart happened while MicVAD.new() was initializing —
        // this instance is stale. Tear it down instead of leaving an
        // orphaned mic stream running.
        void vad.destroy();
        return;
      }
      vadRef.current = vad;
      await vad.start();
      if (gen !== startGenRef.current) {
        void vad.destroy();
        return;
      }
      setCapturing(true);
    } catch (e) {
      console.error("[voice] capture init failed", e);
      setError(e instanceof Error ? e.message : "microphone unavailable");
      setCapturing(false);
    }
  }, []);

  useEffect(() => () => void stop(), [stop]);

  return { capturing, start, stop, error };
}
