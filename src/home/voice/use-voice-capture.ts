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
  onSpeechStart?: () => void;
  onSpeechConfirmed?: () => void;
  onSpeechRealStart?: () => void;
  onVADMisfire?: () => void;
}

const VAD_SAMPLE_RATE = 16000;
const VAD_ASSET_TIMEOUT_MS = 5000;
type VadModel = "legacy" | "v5";

let vadAssetCheckPromise: Promise<void> | null = null;
const VAD_MODEL_PREFERENCE: VadModel[] = ["legacy", "v5"];

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
const VAD_ASSETS = [
  `${VAD_BASE_ASSET_PATH}vad.worklet.bundle.min.js`,
  `${VAD_BASE_ASSET_PATH}silero_vad_legacy.onnx`,
  `${VAD_BASE_ASSET_PATH}silero_vad_v5.onnx`,
  `${VAD_BASE_ASSET_PATH}ort-wasm-simd-threaded.wasm`,
  `${VAD_BASE_ASSET_PATH}ort-wasm-simd-threaded.mjs`,
  `${VAD_BASE_ASSET_PATH}ort-wasm-simd-threaded.jsep.wasm`,
  `${VAD_BASE_ASSET_PATH}ort-wasm-simd-threaded.jsep.mjs`,
] as const;
const noop = () => {};

async function checkAsset(url: string): Promise<void> {
  const request = async (opts: {
    method: "HEAD" | "GET";
    headers?: Record<string, string>;
  }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, VAD_ASSET_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...opts,
        cache: "no-store",
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  let response: Response | null = null;
  try {
    response = await request({ method: "HEAD" });
  } catch (error) {
    console.warn(`[voice] HEAD failed for ${url}, fallback GET`, error);
  }
  if (!response || !response.ok) {
    response = await request({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    });
  }
  if (!response.ok) {
    throw new Error(`VAD asset unavailable: ${url} (${response.status})`);
  }
}

async function ensureVadAssets(): Promise<void> {
  const checks = VAD_ASSETS.map((assetUrl) => checkAsset(assetUrl));

  await Promise.all(checks);
}

function getVADAssetPromise(): Promise<void> {
  if (!vadAssetCheckPromise) {
    vadAssetCheckPromise = ensureVadAssets().catch((err) => {
      vadAssetCheckPromise = null;
      throw err;
    });
  }
  return vadAssetCheckPromise;
}

function runCallbackSafely(
  label: string,
  cb: () => void | Promise<void>,
  setError: (error: string | null) => void,
) {
  try {
    Promise.resolve(cb()).catch((err) => {
      console.error(`[voice] ${label} failed`, err);
      setError(err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    console.error(`[voice] ${label} failed`, err);
    setError(err instanceof Error ? err.message : String(err));
  }
}

async function createVadWithModel(
  model: VadModel,
  options: Parameters<typeof MicVAD.new>[0],
): Promise<MicVAD> {
  return MicVAD.new({
    ...options,
    model,
    startOnLoad: false,
  });
}

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
      await previous.pause().catch(() => undefined);
      await previous.destroy().catch(() => undefined);
    }
    try {
      await getVADAssetPromise();
      let vad: MicVAD | null = null;
      let initError: unknown = null;
      for (const model of VAD_MODEL_PREFERENCE) {
        try {
          vad = await createVadWithModel(model, {
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
            onSpeechStart: () => {
              if (gen !== startGenRef.current) return;
              runCallbackSafely("onSpeechStart", () => {
                (options.onSpeechStart ?? noop)();
              }, setError);
            },
            onSpeechRealStart: () => {
              if (gen !== startGenRef.current) return;
              runCallbackSafely("onSpeechRealStart", () => {
                (options.onSpeechConfirmed ?? noop)();
                (options.onSpeechRealStart ?? noop)();
              }, setError);
            },
            onVADMisfire: () => {
              if (gen !== startGenRef.current) return;
              runCallbackSafely("onVADMisfire", () => {
                (options.onVADMisfire ?? noop)();
              }, setError);
            },
            onSpeechEnd: (audio: Float32Array) => {
              if (gen !== startGenRef.current) return;
              if (audio.length === 0) return;
              runCallbackSafely(
                "onSpeechEnd",
                () => onUtterance(encodeWav(audio, VAD_SAMPLE_RATE)),
                setError,
              );
            },
          });
          await vad.start();
          if (gen !== startGenRef.current) {
            void vad.destroy();
            return;
          }
          break;
        } catch (err) {
          initError = err;
          console.error(`[voice] failed to initialize/start VAD with model ${model}`, err);
          if (vad) {
            await vad.pause().catch(() => undefined);
            await vad.destroy().catch(() => undefined);
            vad = null;
          }
        }
      }
      if (!vad) {
        throw initError instanceof Error
          ? initError
          : new Error("microphone VAD unavailable");
      }
      vadRef.current = vad;
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
