import * as ort from "onnxruntime-web/wasm";
import {
  FRAME_COUNT,
  MEL_BINS,
  MODEL_AUDIO_WINDOW_SAMPLES,
} from "./wake-word-audio";

export interface WakeWordModelInfo {
  model_type: string;
  mel_time: number;
  version: string;
  multi_model: boolean;
  models: Array<{
    wake_word: string;
    model_file: string;
    emb_frames: number;
    cons_frames: number;
  }>;
}

export interface WakeWordModel {
  info: WakeWordModelInfo;
  inputName: string;
  outputName: string;
  melInputName: string;
  melOutputName: string;
  runAudio(samples: Float32Array): Promise<number>;
  runFeatures(features: Float32Array): Promise<number>;
}

const WAKE_WORD_BASE_PATH = "/wake-word/";
const ORT_WASM_BASE_PATH =
  typeof window !== "undefined"
    ? `${window.location.origin}/vad/`
    : "/vad/";
const WAKE_WORD_ASSET_TIMEOUT_MS = 5000;
const WAKE_WORD_ASSETS = [
  "model_info.json",
  "nihaoxiaozhangyu.onnx",
  "melspectrogram.onnx",
] as const;
const ORT_WASM_ASSETS = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.jspi.mjs",
  "ort-wasm-simd-threaded.jspi.wasm",
] as const;
let runtimeConfigured = false;

function joinAsset(basePath: string, file: string): string {
  return `${basePath.replace(/\/?$/, "/")}${file}`;
}

function configureWasmRuntime(): void {
  if (runtimeConfigured || typeof window === "undefined") return;
  ort.env.wasm.wasmPaths = ORT_WASM_BASE_PATH;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  runtimeConfigured = true;
}

async function checkAsset(url: string): Promise<void> {
  const request = async (opts: {
    method: "HEAD" | "GET";
    headers?: Record<string, string>;
  }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, WAKE_WORD_ASSET_TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...opts,
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let response: Response | null = null;
  try {
    response = await request({ method: "HEAD" });
  } catch (error) {
    console.warn(`[wake-word] HEAD failed for ${url}, fallback GET`, error);
  }
  if (!response || !response.ok) {
    response = await request({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    });
  }
  if (!response.ok) {
    throw new Error(`wake-word asset unavailable: ${url} (${response.status})`);
  }
}

async function ensureWakeWordAssets(basePath: string): Promise<void> {
  const wakeAssets = WAKE_WORD_ASSETS.map((asset) =>
    checkAsset(joinAsset(basePath, asset)),
  );
  const ortAssets = ORT_WASM_ASSETS.map((asset) =>
    checkAsset(`${ORT_WASM_BASE_PATH}${asset}`),
  );
  await Promise.all([...wakeAssets, ...ortAssets]);
}

export async function loadWakeWordModel(
  basePath = WAKE_WORD_BASE_PATH,
): Promise<WakeWordModel> {
  configureWasmRuntime();
  await ensureWakeWordAssets(basePath);

  const [infoResponse, session, melSession] = await Promise.all([
    fetch(joinAsset(basePath, "model_info.json")),
    ort.InferenceSession.create(joinAsset(basePath, "nihaoxiaozhangyu.onnx"), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    }),
    ort.InferenceSession.create(joinAsset(basePath, "melspectrogram.onnx"), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    }),
  ]);

  if (!infoResponse.ok) {
    throw new Error(`model_info.json failed: ${infoResponse.status}`);
  }

  const info = (await infoResponse.json()) as WakeWordModelInfo;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const melInputName = melSession.inputNames[0] ?? "input";
  const melOutputName = melSession.outputNames[0];

  const audioToFeatures = async (samples: Float32Array): Promise<Float32Array> => {
    const audio = new Float32Array(MODEL_AUDIO_WINDOW_SAMPLES);
    if (samples.length >= MODEL_AUDIO_WINDOW_SAMPLES) {
      audio.set(samples.slice(samples.length - MODEL_AUDIO_WINDOW_SAMPLES));
    } else {
      audio.set(samples, MODEL_AUDIO_WINDOW_SAMPLES - samples.length);
    }

    for (let i = 0; i < audio.length; i += 1) {
      audio[i] *= 32767;
    }

    const melTensor = new ort.Tensor("float32", audio, [1, audio.length]);
    const melResult = await melSession.run({ [melInputName]: melTensor });
    const mel = melResult[melOutputName].data;
    const frameTotal = Math.floor(mel.length / MEL_BINS);
    const startFrame = Math.max(0, frameTotal - FRAME_COUNT);
    const features = new Float32Array(FRAME_COUNT * MEL_BINS);

    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const sourceFrame = startFrame + frame;
      if (sourceFrame < 0 || sourceFrame >= frameTotal) continue;
      for (let bin = 0; bin < MEL_BINS; bin += 1) {
        const sourceIndex = sourceFrame * MEL_BINS + bin;
        features[frame * MEL_BINS + bin] = Number(mel[sourceIndex]) / 10 + 2;
      }
    }

    return features;
  };

  const runFeatures = async (features: Float32Array): Promise<number> => {
    if (features.length !== FRAME_COUNT * MEL_BINS) {
      throw new Error(`expected ${FRAME_COUNT * MEL_BINS} features, got ${features.length}`);
    }
    const tensor = new ort.Tensor("float32", features, [
      1,
      FRAME_COUNT,
      MEL_BINS,
    ]);
    const result = await session.run({ [inputName]: tensor });
    const data = result[outputName].data;
    const value = Number(data[0]);
    return Number.isFinite(value) ? value : 0;
  };

  return {
    info,
    inputName,
    outputName,
    melInputName,
    melOutputName,
    runFeatures,
    async runAudio(samples: Float32Array) {
      return runFeatures(await audioToFeatures(samples));
    },
  };
}
