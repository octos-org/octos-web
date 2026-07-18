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

// `all` is the standards-defined mode that asks the browser to remove every
// system-played source from the microphone signal, including our local Web
// Audio TTS. TypeScript's current lib.dom still models echoCancellation as a
// boolean-only constraint, so keep the standards-compatible runtime value in
// this narrowly cast object until that declaration catches up.
const MIC_CONSTRAINTS_WITH_ALL_SYSTEM_AEC = {
  channelCount: 1,
  echoCancellation: "all",
  autoGainControl: true,
  noiseSuppression: true,
} as unknown as MediaTrackConstraints;

async function getEchoCancelledMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: MIC_CONSTRAINTS_WITH_ALL_SYSTEM_AEC,
  });
}

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

type CaptureCallbacks = {
  onUtterance: (wav: Blob) => void;
  options: VoiceCaptureStartOptions;
};

function frameProcessorOptions(options: VoiceCaptureStartOptions) {
  return {
    positiveSpeechThreshold: options.positiveSpeechThreshold ?? 0.6,
    negativeSpeechThreshold: options.negativeSpeechThreshold ?? 0.4,
    minSpeechMs: options.minSpeechMs ?? 300,
    redemptionMs: options.redemptionMs ?? 700,
  };
}

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
  // The callbacks/configuration are mutable while one MicVAD remains alive.
  // Voice replies can contain dozens of sentence clips; rebuilding ONNX,
  // AudioContext, and getUserMedia for every clip creates repeated deaf
  // windows. MicVAD supports live frame-processor option updates, and these
  // refs let its stable callbacks always dispatch to the latest voice mode.
  const callbacksRef = useRef<CaptureCallbacks | null>(null);
  const initializationRef = useRef<Promise<void> | null>(null);
  const teardownRef = useRef<Promise<void> | null>(null);
  // Monotonic cancellation token. Only stop() invalidates an in-flight
  // initialization. Repeated start() calls share that initialization and
  // update callbacks/options instead of racing two microphone/VAD instances.
  const startGenRef = useRef(0);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback((): Promise<void> => {
    startGenRef.current++;
    callbacksRef.current = null;
    const vad = vadRef.current;
    vadRef.current = null;
    setCapturing(false);
    const pendingInitialization = initializationRef.current;
    if (!vad && !pendingInitialization) {
      return teardownRef.current ?? Promise.resolve();
    }
    // Return a promise that resolves once teardown finishes so callers can
    // await it BEFORE starting reply playback — otherwise the ONNX/WASM + mic
    // AudioContext shutdown spikes CPU exactly as the reply's Web Audio render
    // thread starts, glitching the first sentence.
    const teardown = (async () => {
      if (vad) {
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
      }
      // An initializer invalidated above destroys its own candidate before it
      // resolves. Await it so a following start() never opens a second mic
      // while the stale candidate is still winding down.
      if (pendingInitialization) {
        await pendingInitialization.catch(() => undefined);
      }
    })();
    teardownRef.current = teardown;
    void teardown.finally(() => {
      if (teardownRef.current === teardown) teardownRef.current = null;
    });
    return teardown;
  }, []);

  const start = useCallback(async (
    onUtterance: (wav: Blob) => void,
    options: VoiceCaptureStartOptions = {},
  ) => {
    setError(null);
    callbacksRef.current = { onUtterance, options };

    const pendingTeardown = teardownRef.current;
    if (pendingTeardown) await pendingTeardown;

    // stop() may have won while this start() was waiting for the previous VAD
    // to finish tearing down. Do not reacquire the microphone after that.
    const latestAfterTeardown = callbacksRef.current;
    if (!latestAfterTeardown) return;

    const active = vadRef.current;
    if (active) {
      active.setOptions(frameProcessorOptions(latestAfterTeardown.options));
      setCapturing(true);
      return;
    }

    // thinking→speaking can happen while the first MicVAD.new() is still
    // loading. Join that work; the initializer reads callbacksRef at dispatch
    // time and applies the latest thresholds before publishing the instance.
    const pendingInitialization = initializationRef.current;
    if (pendingInitialization) {
      try {
        await pendingInitialization;
      } catch {
        // The initializer owner surfaces the capture error. Joining callers
        // must not leak a second rejection from the same failed MicVAD.new().
        return;
      }
      if (initializationRef.current === pendingInitialization) {
        initializationRef.current = null;
      }
      const initialized = vadRef.current;
      if (initialized && callbacksRef.current) {
        initialized.setOptions(
          frameProcessorOptions(callbacksRef.current.options),
        );
        setCapturing(true);
        return;
      }
    }

    const gen = startGenRef.current;
    const initialize = (async () => {
      await getVADAssetPromise();
      let vad: MicVAD | null = null;
      let initError: unknown = null;
      for (const model of VAD_MODEL_PREFERENCE) {
        try {
          vad = await createVadWithModel(model, {
            baseAssetPath: VAD_BASE_ASSET_PATH,
            onnxWASMBasePath: VAD_ONNX_WASM_BASE_PATH,
            getStream: getEchoCancelledMicStream,
            resumeStream: getEchoCancelledMicStream,
            // Less trigger-happy than the defaults so transient noise (keyboard
            // clicks, taps) doesn't register as speech and kick off a turn:
            //  - require a higher speech probability to START,
            //  - require ≥300ms of real speech before it counts as an utterance
            //    (short clicks fall under this and fire onVADMisfire instead),
            //  - wait ~700ms of silence before ending so natural pauses don't cut.
            ...frameProcessorOptions(options),
            onSpeechStart: () => {
              if (gen !== startGenRef.current) return;
              const current = callbacksRef.current;
              if (!current) return;
              runCallbackSafely("onSpeechStart", () => {
                (current.options.onSpeechStart ?? noop)();
              }, setError);
            },
            onSpeechRealStart: () => {
              if (gen !== startGenRef.current) return;
              const current = callbacksRef.current;
              if (!current) return;
              runCallbackSafely("onSpeechRealStart", () => {
                (current.options.onSpeechConfirmed ?? noop)();
                (current.options.onSpeechRealStart ?? noop)();
              }, setError);
            },
            onVADMisfire: () => {
              if (gen !== startGenRef.current) return;
              const current = callbacksRef.current;
              if (!current) return;
              runCallbackSafely("onVADMisfire", () => {
                (current.options.onVADMisfire ?? noop)();
              }, setError);
            },
            onSpeechEnd: (audio: Float32Array) => {
              if (gen !== startGenRef.current) return;
              if (audio.length === 0) return;
              const current = callbacksRef.current;
              if (!current) return;
              runCallbackSafely(
                "onSpeechEnd",
                () => current.onUtterance(encodeWav(audio, VAD_SAMPLE_RATE)),
                setError,
              );
            },
          });
          await vad.start();
          if (gen !== startGenRef.current) {
            await vad.destroy().catch(() => undefined);
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
      const latest = callbacksRef.current;
      if (!latest || gen !== startGenRef.current) {
        await vad.destroy().catch(() => undefined);
        return;
      }
      vad.setOptions(frameProcessorOptions(latest.options));
      vadRef.current = vad;
      setCapturing(true);
    })();
    initializationRef.current = initialize;
    try {
      await initialize;
    } catch (e) {
      console.error("[voice] capture init failed", e);
      setError(e instanceof Error ? e.message : "microphone unavailable");
      setCapturing(false);
    } finally {
      if (initializationRef.current === initialize) {
        initializationRef.current = null;
      }
    }
  }, []);

  useEffect(() => () => void stop(), [stop]);

  return { capturing, start, stop, error };
}
