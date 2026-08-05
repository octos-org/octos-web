import { useEffect, useRef, useState } from "react";
import { Download, Mic, Square, Waves } from "lucide-react";
import {
  getVoiceCaptureDiagnosticConfig,
  type VoiceCaptureFrame,
  type VoiceCaptureModelInfo,
} from "@/home/voice/use-voice-capture";
import { useVoiceCapture } from "@/home/voice/use-voice-capture";
import { LISTENING_VAD_OPTIONS } from "@/home/voice/vad-config";
import {
  VOICE_LAB_METRICS,
  VOICE_LAB_SCENARIOS,
  createVoiceLabLabel,
  wavDurationMs,
  type VoiceLabLabel,
} from "./voice-lab-data";

type LabEventKind =
  | "candidate_started"
  | "candidate_confirmed"
  | "candidate_ended"
  | "candidate_misfire";

interface LabEvent {
  id: number;
  kind: LabEventKind;
  atMs: number;
}

interface RecordedCandidate {
  id: string;
  blob: Blob;
  url: string;
  durationMs: number;
  size: number;
}

interface MicrophoneDiagnostics {
  settings: MediaTrackSettings;
  constraints: MediaTrackConstraints;
  deviceLabel: string | null;
}

const MAX_FRAMES = 600;
const MAX_EVENTS = 100;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

function formatMs(value: number): string {
  return `${Math.max(0, value).toFixed(0)} ms`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function supportedConstraints(): MediaTrackSupportedConstraints {
  return navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
}

export function VoiceLab() {
  const capture = useVoiceCapture();
  // Baseline runs intentionally mirror normal production listening, while the
  // component itself remains isolated from the production turn pipeline.
  const config = getVoiceCaptureDiagnosticConfig(LISTENING_VAD_OPTIONS);
  const startedAtRef = useRef(0);
  const candidateSequenceRef = useRef(0);
  const activeCandidateRef = useRef<string | null>(null);
  const candidateUrlRef = useRef<string | null>(null);
  const [events, setEvents] = useState<LabEvent[]>([]);
  const [frames, setFrames] = useState<VoiceCaptureFrame[]>([]);
  const [model, setModel] = useState<VoiceCaptureModelInfo | null>(null);
  const [microphone, setMicrophone] = useState<MicrophoneDiagnostics | null>(null);
  const [candidate, setCandidate] = useState<RecordedCandidate | null>(null);
  const [label, setLabel] = useState<VoiceLabLabel>(createVoiceLabLabel);
  const [supports] = useState<MediaTrackSupportedConstraints>(supportedConstraints);

  useEffect(() => {
    return () => {
      if (candidateUrlRef.current) URL.revokeObjectURL(candidateUrlRef.current);
    };
  }, []);

  const relativeNow = () => now() - startedAtRef.current;
  const addEvent = (kind: LabEventKind) => {
    setEvents((current) => [
      ...current.slice(-(MAX_EVENTS - 1)),
      { id: current.length + 1, kind, atMs: relativeNow() },
    ]);
  };

  const readMicrophone = (stream: MediaStream) => {
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const settings = track.getSettings();
    const constraints = track.getConstraints();
    const deviceId = settings.deviceId;
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      const deviceLabel = devices.find(
        (device) => device.kind === "audioinput" && device.deviceId === deviceId,
      )?.label ?? null;
      setMicrophone({ settings, constraints, deviceLabel });
    }).catch(() => {
      setMicrophone({ settings, constraints, deviceLabel: null });
    });
  };

  const recordCandidate = (blob: Blob) => {
    const id = activeCandidateRef.current ?? `lab-candidate-${candidateSequenceRef.current + 1}`;
    activeCandidateRef.current = null;
    addEvent("candidate_ended");
    if (candidateUrlRef.current) URL.revokeObjectURL(candidateUrlRef.current);
    const url = URL.createObjectURL(blob);
    candidateUrlRef.current = url;
    setCandidate({
      id,
      blob,
      url,
      size: blob.size,
      durationMs: wavDurationMs(blob.size, config.sampleRate),
    });
  };

  const start = async () => {
    startedAtRef.current = now();
    activeCandidateRef.current = null;
    setEvents([]);
    setFrames([]);
    await capture.start(recordCandidate, {
      ...LISTENING_VAD_OPTIONS,
      onSpeechStart: () => {
        candidateSequenceRef.current += 1;
        activeCandidateRef.current = `lab-candidate-${candidateSequenceRef.current}`;
        addEvent("candidate_started");
      },
      onSpeechConfirmed: () => addEvent("candidate_confirmed"),
      onVADMisfire: () => {
        activeCandidateRef.current = null;
        addEvent("candidate_misfire");
      },
      onFrameProcessed: (frame) => {
        setFrames((current) => [...current.slice(-(MAX_FRAMES - 1)), {
          ...frame,
          atMs: frame.atMs - startedAtRef.current,
        }]);
      },
      onMediaStream: readMicrophone,
      onModelLoaded: setModel,
    });
  };

  const exportJson = () => {
    const report = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      privacy: "Audio remains in this browser unless the user explicitly downloads the WAV.",
      microphone: microphone ? {
        settings: microphone.settings,
        constraints: microphone.constraints,
        deviceLabel: microphone.deviceLabel,
      } : null,
      requestedConstraints: config.requestedConstraints,
      vad: { config: config.defaults, model, frames, events },
      candidate: candidate ? {
        id: candidate.id,
        durationMs: candidate.durationMs,
        wavBytes: candidate.size,
        sampleRate: config.sampleRate,
      } : null,
      label,
      metricsTracked: VOICE_LAB_METRICS,
    };
    download(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
      "octos-voice-lab.json",
    );
  };

  const latestProbability = frames.at(-1)?.speechProbability;

  return (
    <section className="glass-section rounded-lg p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Waves size={20} />
          </div>
          <div>
            <h3 id="voice-lab-title" className="text-sm font-semibold text-text-strong">Voice Lab</h3>
            <p className="mt-1 text-xs text-muted">
              Browser-only microphone and VAD diagnostics. It never starts a chat turn, Agent, tool, Memory, or Learning task.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void start()} disabled={capture.capturing} className="flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
            <Mic size={14} /> Start microphone diagnostic
          </button>
          <button type="button" onClick={() => void capture.stop()} disabled={!capture.capturing} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted disabled:opacity-40">
            <Square size={13} /> Stop
          </button>
        </div>
      </div>

      <p className="mt-4 rounded-lg bg-surface-container px-3 py-2 text-xs text-muted">
        Privacy: recordings stay only in page memory and are discarded when this page closes. No audio is uploaded; JSON excludes audio bytes, and WAV downloads only after your explicit action.
      </p>
      {capture.error && <p role="alert" className="mt-3 text-xs text-red-400">{capture.error}</p>}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <DiagnosticList title="Browser supported audio constraints" value={supports} />
        <DiagnosticList title="Octos requested constraints" value={config.requestedConstraints} />
        <DiagnosticList title="Actual MediaStreamTrack settings" value={microphone?.settings ?? null} />
        <DiagnosticList title="Actual track constraints" value={microphone?.constraints ?? null} />
      </div>
      <p className="mt-2 text-xs text-muted">
        Input device: {microphone?.deviceLabel || microphone?.settings.deviceId || "start a diagnostic to inspect"}
      </p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg bg-surface-container p-4">
          <h4 className="text-xs font-semibold text-text-strong">Loaded Silero VAD</h4>
          {model ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <Term label="Library" value={`${model.library} ${model.libraryVersion}`} />
              <Term label="Model" value={`${model.model} (${model.modelAsset})`} />
              <Term label="Sample rate" value={`${model.sampleRate} Hz`} />
              <Term label="Frame" value={`${model.frameSamples} samples / ${model.frameDurationMs} ms`} />
            </dl>
          ) : <p className="mt-3 text-xs text-muted">Start a diagnostic to report the model that actually loaded.</p>}
        </div>
        <div className="rounded-lg bg-surface-container p-4">
          <h4 className="text-xs font-semibold text-text-strong">Current VAD configuration</h4>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <Term label="Positive threshold" value={String(config.defaults.positiveSpeechThreshold)} />
            <Term label="Negative threshold" value={String(config.defaults.negativeSpeechThreshold)} />
            <Term label="Min speech" value={formatMs(config.defaults.minSpeechMs)} />
            <Term label="Redemption" value={formatMs(config.defaults.redemptionMs)} />
            <Term label="Pre-speech padding" value={formatMs(config.defaults.preSpeechPadMs)} />
            <Term label="Submit on pause" value={String(config.defaults.submitUserSpeechOnPause)} />
          </dl>
          <p className="mt-3 text-xs text-muted">Live speech probability: {latestProbability == null ? "waiting" : latestProbability.toFixed(3)}</p>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-surface-container p-4">
        <h4 className="text-xs font-semibold text-text-strong">Actual input summary</h4>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs md:grid-cols-4">
          <Term label="AEC" value={String(microphone?.settings.echoCancellation ?? "not reported")} />
          <Term label="Noise suppression" value={String(microphone?.settings.noiseSuppression ?? "not reported")} />
          <Term label="Auto gain" value={String(microphone?.settings.autoGainControl ?? "not reported")} />
          <Term label="Sample rate" value={microphone?.settings.sampleRate ? `${microphone.settings.sampleRate} Hz` : "not reported"} />
          <Term label="Channels" value={String(microphone?.settings.channelCount ?? "not reported")} />
          <Term label="Input device" value={microphone?.deviceLabel || microphone?.settings.deviceId || "not reported"} />
        </dl>
      </div>

      <div className="mt-6 rounded-lg bg-surface-container p-4">
        <h4 className="text-xs font-semibold text-text-strong">Candidate timeline</h4>
        {events.length === 0 ? <p className="mt-3 text-xs text-muted">Speak a test sound to see candidate_started, candidate_confirmed, and candidate_ended events.</p> : (
          <ol className="mt-3 space-y-2 text-xs">
            {events.map((event, index) => (
              <li key={event.id} className="flex justify-between gap-4 rounded bg-surface px-3 py-2">
                <code>{event.kind}</code>
                <span>{formatMs(event.atMs)}{index > 0 ? ` (+${formatMs(event.atMs - events[index - 1].atMs)})` : ""}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-muted">{frames.length} VAD frames captured (keeps the newest {MAX_FRAMES}); the library supplies a speech probability per frame.</p>
      </div>

      {candidate && (
        <div className="mt-6 rounded-lg bg-surface-container p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-semibold text-text-strong">Recorded candidate</h4>
              <p className="mt-1 text-xs text-muted">{candidate.id} · {(candidate.durationMs / 1000).toFixed(2)} s · {formatBytes(candidate.size)} WAV</p>
            </div>
            <button type="button" onClick={() => download(candidate.blob, `${candidate.id}.wav`)} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted">
              <Download size={14} /> Download WAV
            </button>
          </div>
          <audio className="mt-3 w-full" controls src={candidate.url} />
        </div>
      )}

      <div className="mt-6 rounded-lg bg-surface-container p-4">
        <h4 className="text-xs font-semibold text-text-strong">Human label</h4>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="text-xs text-muted">containsSpeech
            <select value={label.containsSpeech === null ? "unknown" : String(label.containsSpeech)} onChange={(event) => setLabel((current) => ({ ...current, containsSpeech: event.target.value === "unknown" ? null : event.target.value === "true" }))} className="mt-1 block w-full rounded-lg bg-surface px-3 py-2 text-sm text-text">
              <option value="unknown">Unlabeled</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          </label>
          <label className="text-xs text-muted">Scenario
            <select value={label.scenario} onChange={(event) => setLabel((current) => ({ ...current, scenario: event.target.value as VoiceLabLabel["scenario"] }))} className="mt-1 block w-full rounded-lg bg-surface px-3 py-2 text-sm text-text">
              {VOICE_LAB_SCENARIOS.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted">expectedText
            <input value={label.expectedText} onChange={(event) => setLabel((current) => ({ ...current, expectedText: event.target.value }))} className="mt-1 block w-full rounded-lg bg-surface px-3 py-2 text-sm text-text" />
          </label>
          <label className="text-xs text-muted">notes
            <input value={label.notes} onChange={(event) => setLabel((current) => ({ ...current, notes: event.target.value }))} className="mt-1 block w-full rounded-lg bg-surface px-3 py-2 text-sm text-text" />
          </label>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">Tracks {VOICE_LAB_METRICS.length} agreed VAD, ASR, and end-to-end acceptance metrics for later baseline analysis.</p>
        <button type="button" onClick={exportJson} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted"><Download size={14} /> Export experiment JSON</button>
      </div>
    </section>
  );
}

function DiagnosticList({ title, value }: { title: string; value: Record<string, unknown> | null }) {
  return <div className="rounded-lg bg-surface-container p-4"><h4 className="text-xs font-semibold text-text-strong">{title}</h4>{value ? <dl className="mt-3 space-y-1 text-xs">{Object.entries(value).map(([key, entry]) => <Term key={key} label={key} value={String(entry)} />)}</dl> : <p className="mt-3 text-xs text-muted">Not available until microphone access is granted.</p>}</div>;
}

function Term({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd className="break-all text-right text-text">{value}</dd></div>;
}
