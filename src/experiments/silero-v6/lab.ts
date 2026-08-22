import "./lab.css";
import {
  DetectionTracker,
  FrameAssembler,
  SILERO_FRAME_MS,
  type DetectionConfig,
  type DetectionEvent,
  average,
  percentile,
} from "./core";
import {
  BrowserSileroModel,
  configureOnnxRuntime,
  type ModelFrameResult,
} from "./model";

type ModelName = "v5" | "v6";

type RecordedEvent = DetectionEvent & {
  model: ModelName;
  scenario: string;
};

type ModelSeries = {
  probabilities: number[];
  inferenceMs: number[];
  events: RecordedEvent[];
  active: boolean;
};

const v6ModelUrl = new URL(
  "../../../experiments/silero-v6-browser/assets/silero_vad_v6.2.1_16k_op15.onnx",
  import.meta.url,
).href;
const captureWorkletUrl = new URL(
  "../../../experiments/silero-v6-browser/pcm-capture.worklet.js",
  import.meta.url,
).href;

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`Missing experiment element #${id}`);
  return target as T;
}

const startButton = element<HTMLButtonElement>("startButton");
const stopButton = element<HTMLButtonElement>("stopButton");
const resetButton = element<HTMLButtonElement>("resetButton");
const exportButton = element<HTMLButtonElement>("exportButton");
const statusBadge = element<HTMLDivElement>("statusBadge");
const statusText = element<HTMLParagraphElement>("statusText");
const scenarioSelect = element<HTMLSelectElement>("scenarioSelect");
const chart = element<HTMLCanvasElement>("probabilityChart");
const eventLog = element<HTMLOListElement>("eventLog");
const frameCounter = element<HTMLSpanElement>("frameCounter");

const positiveThreshold = element<HTMLInputElement>("positiveThreshold");
const negativeThreshold = element<HTMLInputElement>("negativeThreshold");
const minSpeech = element<HTMLInputElement>("minSpeech");
const redemption = element<HTMLInputElement>("redemption");

const configurableInputs = [
  positiveThreshold,
  negativeThreshold,
  minSpeech,
  redemption,
];

const series: Record<ModelName, ModelSeries> = {
  v5: { probabilities: [], inferenceMs: [], events: [], active: false },
  v6: { probabilities: [], inferenceMs: [], events: [], active: false },
};

const assembler = new FrameAssembler();
let trackers: Record<ModelName, DetectionTracker> | null = null;
let v5Model: BrowserSileroModel | null = null;
let v6Model: BrowserSileroModel | null = null;
let stream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let captureNode: AudioWorkletNode | null = null;
let silentGain: GainNode | null = null;
let running = false;
let frameIndex = 0;
let processingQueue = Promise.resolve();

function readConfig(): DetectionConfig {
  return {
    positiveSpeechThreshold: Number(positiveThreshold.value),
    negativeSpeechThreshold: Number(negativeThreshold.value),
    minSpeechMs: Number(minSpeech.value),
    redemptionMs: Number(redemption.value),
  };
}

function makeTrackers() {
  const config = readConfig();
  trackers = {
    v5: new DetectionTracker(config),
    v6: new DetectionTracker(config),
  };
}

function setStatus(
  state: "idle" | "loading" | "running" | "error",
  badge: string,
  detail: string,
) {
  statusBadge.dataset.state = state;
  statusBadge.textContent = badge;
  statusText.textContent = detail;
}

function setControlsForRun(isRunning: boolean) {
  startButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
  resetButton.disabled = isRunning;
  for (const input of configurableInputs) input.disabled = isRunning;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function updateRangeLabels() {
  element<HTMLOutputElement>("positiveThresholdValue").value = Number(
    positiveThreshold.value,
  ).toFixed(2);
  element<HTMLOutputElement>("negativeThresholdValue").value = Number(
    negativeThreshold.value,
  ).toFixed(2);
  element<HTMLOutputElement>("minSpeechValue").value = `${minSpeech.value}ms`;
  element<HTMLOutputElement>("redemptionValue").value = `${redemption.value}ms`;
  drawChart();
}

function modelElement(model: ModelName, suffix: string) {
  return element<HTMLElement>(`${model}${suffix}`);
}

function updateModelSummary(model: ModelName) {
  const data = series[model];
  const probabilities = data.probabilities;
  const inference = data.inferenceMs;
  const confirmed = data.events.filter(
    (event) => event.type === "speech_confirmed",
  ).length;
  const misfires = data.events.filter((event) => event.type === "misfire").length;

  modelElement(model, "Average").textContent = probabilities.length
    ? average(probabilities).toFixed(3)
    : "—";
  modelElement(model, "Maximum").textContent = probabilities.length
    ? Math.max(...probabilities).toFixed(3)
    : "—";
  modelElement(model, "Confirmed").textContent = String(confirmed);
  modelElement(model, "Misfires").textContent = String(misfires);
  modelElement(model, "InferenceAverage").textContent = inference.length
    ? formatMilliseconds(average(inference))
    : "—";
  modelElement(model, "InferenceP95").textContent = inference.length
    ? formatMilliseconds(percentile(inference, 0.95))
    : "—";

  const liveState = modelElement(model, "LiveState");
  liveState.dataset.active = String(data.active);
  liveState.textContent = data.active
    ? "已确认语音"
    : running
      ? "监听中"
      : frameIndex > 0
        ? "已停止"
        : "等待";
}

const eventLabels: Record<DetectionEvent["type"], string> = {
  candidate_start: "出现候选",
  speech_confirmed: "确认语音",
  speech_end: "语音结束",
  misfire: "短噪声候选",
};

function recordEvents(model: ModelName, events: DetectionEvent[]) {
  if (events.length === 0) return;
  const scenario = scenarioSelect.value;
  for (const event of events) {
    const recorded: RecordedEvent = { ...event, model, scenario };
    series[model].events.push(recorded);
    if (event.type === "speech_confirmed") series[model].active = true;
    if (event.type === "speech_end" || event.type === "misfire") {
      series[model].active = false;
    }
    appendEvent(recorded);
  }
}

function appendEvent(event: RecordedEvent) {
  eventLog.querySelector(".empty-event")?.remove();
  const item = document.createElement("li");
  const model = document.createElement("strong");
  const time = document.createElement("span");
  const description = document.createElement("span");
  model.textContent = event.model === "v5" ? "Silero v5" : "Silero v6.2.1";
  time.textContent = `${(event.atMs / 1_000).toFixed(2)}s`;
  description.textContent = `${eventLabels[event.type]} · ${event.scenario}`;
  item.append(model, time, description);
  eventLog.prepend(item);
  while (eventLog.children.length > 100) eventLog.lastElementChild?.remove();
}

function drawChart() {
  const context = chart.getContext("2d");
  if (!context) return;
  const bounds = chart.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(300, Math.floor(bounds.width));
  const height = Math.max(180, Math.floor(bounds.height));
  if (chart.width !== width * scale || chart.height !== height * scale) {
    chart.width = width * scale;
    chart.height = height * scale;
  }
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);

  const padding = { left: 42, right: 16, top: 14, bottom: 26 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  context.strokeStyle = "#dfe3de";
  context.fillStyle = "#758681";
  context.font = "11px ui-monospace, monospace";
  context.lineWidth = 1;

  for (let step = 0; step <= 4; step += 1) {
    const value = step / 4;
    const y = padding.top + plotHeight * (1 - value);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillText(value.toFixed(2), 5, y + 4);
  }

  const thresholdY =
    padding.top + plotHeight * (1 - Number(positiveThreshold.value));
  context.save();
  context.setLineDash([5, 5]);
  context.strokeStyle = "#d68e32";
  context.beginPath();
  context.moveTo(padding.left, thresholdY);
  context.lineTo(width - padding.right, thresholdY);
  context.stroke();
  context.restore();

  const maxPoints = 300;
  const v5 = series.v5.probabilities.slice(-maxPoints);
  const v6 = series.v6.probabilities.slice(-maxPoints);
  const pointCount = Math.max(v5.length, v6.length, 2);

  const drawSeries = (values: readonly number[], color: string) => {
    if (values.length === 0) return;
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    values.forEach((value, index) => {
      const x = padding.left + (index / (pointCount - 1)) * plotWidth;
      const y = padding.top + (1 - value) * plotHeight;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };

  drawSeries(v5, "#497fcc");
  drawSeries(v6, "#159581");
  context.fillText(
    `最近 ${(pointCount * SILERO_FRAME_MS / 1_000).toFixed(1)} 秒`,
    width - padding.right - 92,
    height - 7,
  );
}

function updateInterface(model: ModelName, loaded: BrowserSileroModel) {
  modelElement(model, "Load").textContent = formatMilliseconds(loaded.loadMs);
  modelElement(model, "Interface").textContent =
    `inputs: ${loaded.inputNames.join(", ")} · outputs: ${loaded.outputNames.join(", ")}`;
}

function addResult(model: ModelName, result: ModelFrameResult) {
  series[model].probabilities.push(result.probability);
  series[model].inferenceMs.push(result.inferenceMs);
}

async function processFrame(frame: Float32Array) {
  if (!running || !v5Model || !v6Model || !trackers) return;
  const currentFrame = frameIndex;
  frameIndex += 1;

  const v5Result = await v5Model.process(frame);
  const v6Result = await v6Model.process(frame);
  addResult("v5", v5Result);
  addResult("v6", v6Result);
  recordEvents(
    "v5",
    trackers.v5.update(v5Result.probability, currentFrame),
  );
  recordEvents(
    "v6",
    trackers.v6.update(v6Result.probability, currentFrame),
  );

  if (currentFrame % 4 === 0) {
    updateModelSummary("v5");
    updateModelSummary("v6");
    frameCounter.textContent =
      `${frameIndex} 帧 · ${(frameIndex * SILERO_FRAME_MS / 1_000).toFixed(1)} 秒`;
    drawChart();
  }
}

function handleExperimentError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[silero-v6-lab]", error);
  setStatus("error", "实验失败", message);
  running = false;
  setControlsForRun(false);
  void releaseResources();
}

async function releaseResources() {
  captureNode?.disconnect();
  sourceNode?.disconnect();
  silentGain?.disconnect();
  captureNode = null;
  sourceNode = null;
  silentGain = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  if (audioContext && audioContext.state !== "closed") {
    await audioContext.close().catch(() => undefined);
  }
  audioContext = null;

  const models = [v5Model, v6Model].filter(
    (model): model is BrowserSileroModel => model !== null,
  );
  v5Model = null;
  v6Model = null;
  await Promise.all(models.map((model) => model.release().catch(() => undefined)));
}

async function startExperiment() {
  if (running) return;
  setControlsForRun(true);
  setStatus("loading", "正在加载", "加载 v5 与官方 v6.2.1 ONNX 模型……");

  try {
    configureOnnxRuntime(`${window.location.origin}/vad/`);
    [v5Model, v6Model] = await Promise.all([
      BrowserSileroModel.load({
        label: "v5",
        modelUrl: "/vad/silero_vad_v5.onnx",
        contextSamples: 0,
      }),
      BrowserSileroModel.load({
        label: "v6.2.1",
        modelUrl: v6ModelUrl,
        contextSamples: 64,
      }),
    ]);
    updateInterface("v5", v5Model);
    updateInterface("v6", v6Model);

    audioContext = new AudioContext({ sampleRate: 16_000 });
    if (audioContext.sampleRate !== 16_000) {
      throw new Error(
        `浏览器创建了 ${audioContext.sampleRate}Hz AudioContext；实验要求 16000Hz，不能在不同采样率下比较。`,
      );
    }
    await audioContext.audioWorklet.addModule(captureWorkletUrl);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    });
    sourceNode = audioContext.createMediaStreamSource(stream);
    captureNode = new AudioWorkletNode(
      audioContext,
      "pcm-capture-processor",
      { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] },
    );
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(captureNode);
    captureNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const frame of assembler.push(event.data)) {
        processingQueue = processingQueue
          .then(() => processFrame(frame))
          .catch(handleExperimentError);
      }
    };
    await audioContext.resume();
    makeTrackers();
    running = true;
    setStatus(
      "running",
      "正在采样",
      "两个模型正在处理相同的 16kHz / 512-sample 音频帧。切换场景标签不会中断录音。",
    );
  } catch (error) {
    handleExperimentError(error);
  }
}

async function stopExperiment() {
  if (!running && !v5Model && !v6Model) return;
  running = false;
  const pending = processingQueue;
  await pending.catch(() => undefined);
  if (trackers) {
    recordEvents("v5", trackers.v5.flush(frameIndex));
    recordEvents("v6", trackers.v6.flush(frameIndex));
  }
  await releaseResources();
  setControlsForRun(false);
  updateModelSummary("v5");
  updateModelSummary("v6");
  setStatus("idle", "已停止", "数据保留在页面中；可以导出 JSON 或清空后重新测试。");
}

function resetExperiment() {
  if (running) return;
  for (const data of Object.values(series)) {
    data.probabilities.length = 0;
    data.inferenceMs.length = 0;
    data.events.length = 0;
    data.active = false;
  }
  frameIndex = 0;
  assembler.reset();
  trackers = null;
  eventLog.replaceChildren();
  const placeholder = document.createElement("li");
  placeholder.className = "empty-event";
  placeholder.textContent = "尚无事件。选择测试场景并启动麦克风。";
  eventLog.append(placeholder);
  frameCounter.textContent = "0 帧 · 0.0 秒";
  updateModelSummary("v5");
  updateModelSummary("v6");
  drawChart();
  setStatus("idle", "未启动", "点击“启动麦克风”后加载两个 ONNX 模型。");
}

function exportResults() {
  const payload = {
    exportedAt: new Date().toISOString(),
    sampleRate: 16_000,
    frameSamples: 512,
    frameMs: SILERO_FRAME_MS,
    config: readConfig(),
    models: {
      v5: {
        source: "@ricky0123/vad-web@0.0.30",
        ...series.v5,
      },
      v6: {
        source:
          "snakers4/silero-vad v6.2.1 silero_vad_16k_op15.onnx",
        sha256:
          "7ed98ddbad84ccac4cd0aeb3099049280713df825c610a8ed34543318f1b2c49",
        ...series.v6,
      },
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `silero-v5-v6-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

startButton.addEventListener("click", () => void startExperiment());
stopButton.addEventListener("click", () => void stopExperiment());
resetButton.addEventListener("click", resetExperiment);
exportButton.addEventListener("click", exportResults);
for (const input of configurableInputs) {
  input.addEventListener("input", updateRangeLabels);
}
window.addEventListener("resize", drawChart);
window.addEventListener("beforeunload", () => {
  running = false;
  for (const track of stream?.getTracks() ?? []) track.stop();
});

updateRangeLabels();
updateModelSummary("v5");
updateModelSummary("v6");
drawChart();
