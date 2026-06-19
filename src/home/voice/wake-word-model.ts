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
let runtimeConfigured = false;

function joinAsset(basePath: string, file: string): string {
  return `${basePath.replace(/\/?$/, "/")}${file}`;
}

function configureWasmRuntime(): void {
  if (runtimeConfigured || typeof window === "undefined") return;
  const base = `${window.location.origin}/vad/`;
  ort.env.wasm.wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded.mjs`,
    wasm: `${base}ort-wasm-simd-threaded.wasm`,
  };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  runtimeConfigured = true;
}

export async function loadWakeWordModel(
  basePath = WAKE_WORD_BASE_PATH,
): Promise<WakeWordModel> {
  configureWasmRuntime();

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
