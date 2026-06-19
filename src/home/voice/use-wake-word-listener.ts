import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_WAKE_AUDIO_SAMPLES,
  MODEL_AUDIO_WINDOW_SAMPLES,
  appendSamples,
  isWakeWordOriginAllowed,
  resampleLinear,
} from "./wake-word-audio";
import {
  loadWakeWordModel,
  type WakeWordModel,
} from "./wake-word-model";

export type WakeWordListenerState =
  | "unsupported"
  | "loading"
  | "idle"
  | "starting"
  | "listening"
  | "detected"
  | "error";

export interface WakeWordDetection {
  at: number;
  score: number;
  wakeWord: string;
}

export interface WakeWordListenerOptions {
  enabled: boolean;
  threshold?: number;
  consecutiveFrames?: number;
  onDetected: (detection: WakeWordDetection) => void;
}

export interface WakeWordListener {
  state: WakeWordListenerState;
  score: number;
  error: string | null;
  wakeWord: string;
  supported: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export type WakeWordStatusTone = "default" | "success" | "warning" | "danger";

export interface WakeWordStatusView {
  label: string;
  tone: WakeWordStatusTone;
}

const DEFAULT_WAKE_WORD = "你好小章鱼";
const DEFAULT_THRESHOLD = 0.4;
const DEFAULT_CONSECUTIVE_FRAMES = 3;
const WORKLET_URL = "/wake-word/audio-input-processor.js";

export function describeWakeWordListener(
  state: WakeWordListenerState,
  wakeWord = DEFAULT_WAKE_WORD,
  error: string | null = null,
): WakeWordStatusView {
  switch (state) {
    case "loading":
      return { label: `正在加载「${wakeWord}」`, tone: "default" };
    case "starting":
      return { label: `允许麦克风后自动听「${wakeWord}」`, tone: "warning" };
    case "listening":
      return { label: `说「${wakeWord}」`, tone: "success" };
    case "detected":
      return { label: "已唤醒", tone: "success" };
    case "unsupported":
      return { label: "当前浏览器不支持唤醒", tone: "warning" };
    case "error":
      return { label: error ? "唤醒词不可用" : "唤醒词出错", tone: "danger" };
    case "idle":
    default:
      return { label: `说「${wakeWord}」唤醒`, tone: "default" };
  }
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}

function hasMediaSupport(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  return Boolean(getAudioContextCtor() && navigator.mediaDevices?.getUserMedia);
}

export function useWakeWordListener({
  enabled,
  threshold = DEFAULT_THRESHOLD,
  consecutiveFrames = DEFAULT_CONSECUTIVE_FRAMES,
  onDetected,
}: WakeWordListenerOptions): WakeWordListener {
  const supported = hasMediaSupport();
  const [state, setState] = useState<WakeWordListenerState>(
    supported ? "idle" : "unsupported",
  );
  const [score, setScore] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);

  const modelRef = useRef<WakeWordModel | null>(null);
  const stateRef = useRef<WakeWordListenerState>(state);
  const onDetectedRef = useRef(onDetected);
  const thresholdRef = useRef(threshold);
  const consecutiveFramesRef = useRef(consecutiveFrames);
  const inferenceBusyRef = useRef(false);
  const consecutiveRef = useRef(0);
  const bufferRef = useRef<Float32Array<ArrayBufferLike>>(new Float32Array(0));
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const monitorRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  onDetectedRef.current = onDetected;
  thresholdRef.current = threshold;
  consecutiveFramesRef.current = consecutiveFrames;

  const setListenerState = useCallback((next: WakeWordListenerState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const cleanupAudio = useCallback(async () => {
    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    processorRef.current?.disconnect();
    monitorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (contextRef.current && contextRef.current.state !== "closed") {
      await contextRef.current.close().catch(() => undefined);
    }
    processorRef.current = null;
    workletRef.current = null;
    monitorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    contextRef.current = null;
    bufferRef.current = new Float32Array(0);
    consecutiveRef.current = 0;
    inferenceBusyRef.current = false;
  }, []);

  const stop = useCallback(async () => {
    await cleanupAudio();
    if (stateRef.current !== "unsupported" && stateRef.current !== "error") {
      setListenerState(modelRef.current ? "idle" : "loading");
    }
  }, [cleanupAudio, setListenerState]);

  const wakeWord = modelRef.current?.info.models[0]?.wake_word ?? DEFAULT_WAKE_WORD;

  const runAudioWindow = useCallback(
    async (samples: Float32Array) => {
      const model = modelRef.current;
      if (!model || inferenceBusyRef.current || stateRef.current !== "listening") {
        return;
      }

      inferenceBusyRef.current = true;
      try {
        const nextScore = await model.runAudio(samples);
        setScore(nextScore);
        if (nextScore >= thresholdRef.current) {
          consecutiveRef.current += 1;
        } else {
          consecutiveRef.current = 0;
        }

        if (consecutiveRef.current >= consecutiveFramesRef.current) {
          const detectedWakeWord =
            model.info.models[0]?.wake_word ?? DEFAULT_WAKE_WORD;
          const detection: WakeWordDetection = {
            at: Date.now(),
            score: nextScore,
            wakeWord: detectedWakeWord,
          };
          setListenerState("detected");
          await cleanupAudio();
          onDetectedRef.current(detection);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setListenerState("error");
        await cleanupAudio();
      } finally {
        inferenceBusyRef.current = false;
      }
    },
    [cleanupAudio, setListenerState],
  );

  const start = useCallback(async () => {
    const model = modelRef.current;
    if (
      !supported ||
      !model ||
      stateRef.current === "starting" ||
      stateRef.current === "listening"
    ) {
      return;
    }

    if (!isWakeWordOriginAllowed()) {
      setError("麦克风需要 localhost、局域网地址或 HTTPS。");
      setListenerState("error");
      return;
    }

    try {
      setError(null);
      setScore(0);
      consecutiveRef.current = 0;
      bufferRef.current = new Float32Array(0);
      setListenerState("starting");

      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) throw new Error("AudioContext unavailable");
      const context = new AudioContextCtor({ latencyHint: "interactive" });
      await context.resume().catch(() => undefined);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const source = context.createMediaStreamSource(stream);

      const processSamples = (samples: Float32Array, inputRate: number) => {
        const incoming = resampleLinear(samples, inputRate);
        bufferRef.current = appendSamples(
          bufferRef.current,
          incoming,
          MAX_WAKE_AUDIO_SAMPLES,
        );
        if (
          bufferRef.current.length < MODEL_AUDIO_WINDOW_SAMPLES ||
          inferenceBusyRef.current
        ) {
          return;
        }
        void runAudioWindow(bufferRef.current.slice(-MODEL_AUDIO_WINDOW_SAMPLES));
      };

      if (context.audioWorklet) {
        await context.audioWorklet.addModule(WORKLET_URL);
        const worklet = new AudioWorkletNode(context, "octos-audio-input", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        const monitor = context.createGain();
        monitor.gain.value = 0;
        worklet.port.onmessage = (
          event: MessageEvent<{ samples: Float32Array; sampleRate: number }>,
        ) => {
          processSamples(event.data.samples, event.data.sampleRate);
        };
        source.connect(worklet);
        worklet.connect(monitor);
        monitor.connect(context.destination);
        workletRef.current = worklet;
        monitorRef.current = monitor;
      } else {
        const processor = context.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          event.outputBuffer.getChannelData(0).fill(0);
          processSamples(event.inputBuffer.getChannelData(0), context.sampleRate);
        };
        source.connect(processor);
        processor.connect(context.destination);
        processorRef.current = processor;
      }

      contextRef.current = context;
      sourceRef.current = source;
      streamRef.current = stream;
      setListenerState("listening");
    } catch (err) {
      await cleanupAudio();
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setListenerState("error");
    }
  }, [cleanupAudio, runAudioWindow, setListenerState, supported]);

  useEffect(() => {
    if (!supported || !enabled || modelRef.current) return;
    let cancelled = false;
    setListenerState("loading");
    loadWakeWordModel()
      .then((model) => {
        if (cancelled) return;
        modelRef.current = model;
        setModelReady(true);
        setListenerState("idle");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setListenerState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, setListenerState, supported]);

  useEffect(() => {
    if (!enabled) {
      void stop();
      return;
    }
    if (modelReady && stateRef.current === "idle") {
      void start();
    }
  }, [enabled, modelReady, start, stop]);

  useEffect(() => {
    return () => {
      void cleanupAudio();
    };
  }, [cleanupAudio]);

  return {
    state,
    score,
    error,
    wakeWord,
    supported,
    start,
    stop,
  };
}
