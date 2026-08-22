import * as ort from "onnxruntime-web/wasm";
import { SILERO_FRAME_SAMPLES, SILERO_SAMPLE_RATE } from "./core";

type ModelConfig = {
  label: "v5" | "v6.2.1";
  modelUrl: string;
  contextSamples: number;
};

export type ModelFrameResult = {
  probability: number;
  inferenceMs: number;
};

function zeroState() {
  return new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
}

export function configureOnnxRuntime(baseUrl: string) {
  ort.env.wasm.wasmPaths = baseUrl;
  ort.env.wasm.numThreads = 1;
}

export class BrowserSileroModel {
  readonly label: ModelConfig["label"];
  readonly loadMs: number;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];

  private readonly session: ort.InferenceSession;
  private state: ort.Tensor = zeroState();
  private readonly sampleRate = new ort.Tensor("int64", [
    BigInt(SILERO_SAMPLE_RATE),
  ]);
  private readonly context: Float32Array;

  private constructor(
    session: ort.InferenceSession,
    config: ModelConfig,
    loadMs: number,
  ) {
    this.session = session;
    this.label = config.label;
    this.loadMs = loadMs;
    this.context = new Float32Array(config.contextSamples);
    this.inputNames = session.inputNames;
    this.outputNames = session.outputNames;
  }

  static async load(config: ModelConfig): Promise<BrowserSileroModel> {
    const startedAt = performance.now();
    const response = await fetch(config.modelUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(
        `${config.label} model fetch failed (${response.status}): ${config.modelUrl}`,
      );
    }
    const bytes = await response.arrayBuffer();
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    return new BrowserSileroModel(
      session,
      config,
      performance.now() - startedAt,
    );
  }

  async process(frame: Float32Array): Promise<ModelFrameResult> {
    if (frame.length !== SILERO_FRAME_SAMPLES) {
      throw new Error(
        `${this.label} expected ${SILERO_FRAME_SAMPLES} samples, got ${frame.length}`,
      );
    }

    const audio = new Float32Array(this.context.length + frame.length);
    audio.set(this.context);
    audio.set(frame, this.context.length);
    if (this.context.length > 0) {
      this.context.set(audio.subarray(audio.length - this.context.length));
    }

    const input = new ort.Tensor("float32", audio, [1, audio.length]);
    const previousState = this.state;
    const startedAt = performance.now();
    const output = await this.session.run({
      input,
      state: previousState,
      sr: this.sampleRate,
    });
    const inferenceMs = performance.now() - startedAt;
    input.dispose();

    const nextState = output.stateN;
    const probabilityOutput = output.output;
    if (!nextState || !probabilityOutput) {
      for (const tensor of Object.values(output)) tensor.dispose();
      throw new Error(
        `${this.label} returned [${Object.keys(output).join(", ")}], expected output and stateN`,
      );
    }

    this.state = nextState;
    previousState.dispose();
    const probability = Number(probabilityOutput.data[0]);
    probabilityOutput.dispose();

    if (!Number.isFinite(probability)) {
      throw new Error(`${this.label} returned a non-numeric probability`);
    }

    return { probability, inferenceMs };
  }

  reset() {
    this.state.dispose();
    this.state = zeroState();
    this.context.fill(0);
  }

  async release() {
    this.state.dispose();
    this.sampleRate.dispose();
    await this.session.release();
  }
}
