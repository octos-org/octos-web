import { useCallback, useEffect, useRef, useState } from "react";
import { uploadFiles } from "@/api/chat";
import {
  interruptActiveTurn,
  sendMessage,
} from "@/runtime/ui-protocol-send";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import { useThreads, type Thread, type ThreadMessage } from "@/store/thread-store";
import { buildFileUrl } from "@/api/files";
import { buildApiHeaders } from "@/api/client";
import { useVoiceCapture } from "./use-voice-capture";
import { useCameraFrame } from "./use-camera-frame";
import { playAudioBlob, stopAudio, unlockAudio } from "./audio-playback";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface VoiceConversation {
  state: VoiceState;
  lastUserText: string;
  lastAssistantText: string;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  interrupt: () => void;
  /** Whether the camera is on (each spoken turn then attaches a frame). */
  cameraActive: boolean;
  /** Live camera stream for the self-preview (null when off). */
  cameraStream: MediaStream | null;
  /** Object URL of the exact frame last sent to the AI (the model's view —
   *  downscaled, not mirrored). Replaced on the next send, auto-cleared after
   *  a while. Null when none/expired. */
  lastSentFrameUrl: string | null;
  /** Last camera error (permission denied / no device). */
  cameraError: string | null;
  /** Toggle the camera on/off. */
  toggleCamera: () => void;
  /** The latest rich-output artifact (image/HTML) to render, or null. */
  visual: VisualArtifact | null;
  /** True while a visual is being generated (marker seen, artifact not yet in). */
  generating: boolean;
  /** Dismiss the currently shown visual artifact. */
  dismissVisual: () => void;
}

/** A rich-output artifact the assistant produced for this voice turn. */
export type VisualKind = "html" | "image";
export interface VisualArtifact {
  /** Workspace-relative path, fetched via /api/files (session-scoped). */
  path: string;
  kind: VisualKind;
}

/**
 * Assemble the files for one spoken turn: always the audio, plus a camera frame
 * when the camera is on and a frame is available. A failed/empty grab degrades
 * to audio-only so the turn still goes through. Exported for unit tests.
 */
export async function assembleTurnFiles(
  audio: File,
  cameraActive: boolean,
  grabFrame: () => Promise<File | null>,
): Promise<File[]> {
  if (!cameraActive) return [audio];
  const frame = await grabFrame();
  return frame ? [audio, frame] : [audio];
}

const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|flac)$/i;

/** Safety net: if no reply audio shows up within this window after sending,
 *  return to listening. On-device ominix can thrash ASR↔TTS model reloads
 *  under memory pressure (tens of seconds each), so this is deliberately
 *  generous; cloud STT/TTS or more RAM would let us shrink it. */
const REPLY_TIMEOUT_MS = 90000;
/** How long the "frame sent to the AI" thumbnail lingers before auto-hiding. */
const SENT_FRAME_TTL_MS = 12000;
const LISTENING_VAD_OPTIONS = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  minSpeechMs: 220,
  redemptionMs: 700,
};
const THINKING_INTERRUPT_VAD_OPTIONS = {
  positiveSpeechThreshold: 0.75,
  negativeSpeechThreshold: 0.55,
  minSpeechMs: 700,
  redemptionMs: 650,
};

/** Find the most recent unplayed assistant audio from threads. Exported for unit tests. */
export function pickFreshAudio(
  threads: Thread[],
  played: Set<string>,
): { path: string; text: string } | null {
  for (let i = threads.length - 1; i >= 0; i--) {
    const t = threads[i];
    const asst = t.responses.filter((m: ThreadMessage) => m.role === "assistant");
    for (let j = asst.length - 1; j >= 0; j--) {
      const audio = asst[j].files.find((f) => AUDIO_EXT.test(f.path));
      if (audio && !played.has(audio.path)) {
        return { path: audio.path, text: asst[j].text };
      }
    }
  }
  return null;
}

/** Collect ALL unplayed assistant audio in chronological order (oldest first).
 *  Used for sentence-streamed replies: one turn emits several audio files that
 *  must play in arrival order. Exported for unit tests. */
export function collectFreshAudio(
  threads: Thread[],
  played: Set<string>,
  ignoredThreadIds: Set<string> = new Set(),
): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (let i = 0; i < threads.length; i++) {
    if (ignoredThreadIds.has(threads[i].id)) continue;
    const asst = threads[i].responses.filter(
      (m: ThreadMessage) => m.role === "assistant",
    );
    for (let j = 0; j < asst.length; j++) {
      for (const f of asst[j].files) {
        if (AUDIO_EXT.test(f.path) && !played.has(f.path)) {
          out.push({ path: f.path, text: asst[j].text });
        }
      }
    }
  }
  return out;
}

const HTML_EXT = /\.html?$/i;
const VISUAL_IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
/** Mirror of the backend in-band marker `[[VISUAL:kind|brief]]`. */
const VISUAL_MARKER = /\[\[VISUAL:(html|image|infographic)\|([^\]]*)\]\]/;
/** Safety net: clear the "generating" state if no artifact arrives in time. */
const VISUAL_TIMEOUT_MS = 90000;

/** Whether the assistant reply carries an in-band visual marker. */
export function hasVisualMarker(text: string): boolean {
  const m = VISUAL_MARKER.exec(text);
  return m !== null && m[2].trim().length > 0;
}

/** Strip a trailing `[[VISUAL:...]]` marker so it isn't shown to the user. */
export function stripVisualMarker(text: string): string {
  const i = text.indexOf("[[VISUAL:");
  return i >= 0 ? text.slice(0, i).trimEnd() : text;
}

/** Collect ALL unseen assistant visual artifacts (image/HTML) in order. */
export function collectFreshVisuals(
  threads: Thread[],
  seen: Set<string>,
  ignoredThreadIds: Set<string> = new Set(),
): VisualArtifact[] {
  const out: VisualArtifact[] = [];
  for (let i = 0; i < threads.length; i++) {
    if (ignoredThreadIds.has(threads[i].id)) continue;
    const asst = threads[i].responses.filter(
      (m: ThreadMessage) => m.role === "assistant",
    );
    for (let j = 0; j < asst.length; j++) {
      for (const f of asst[j].files) {
        if (seen.has(f.path)) continue;
        if (HTML_EXT.test(f.path)) out.push({ path: f.path, kind: "html" });
        else if (VISUAL_IMAGE_EXT.test(f.path))
          out.push({ path: f.path, kind: "image" });
      }
    }
  }
  return out;
}

export function useVoiceConversation(
  sessionId: string,
  historyTopic?: string,
): VoiceConversation {
  const threads = useThreads(sessionId, historyTopic);
  const capture = useVoiceCapture();
  // Destructure the STABLE function refs (useVoiceCapture returns a fresh
  // object each render, but start/stop are useCallback([])-stable). Depending
  // on `capture` the object would churn identity every render and make the
  // unmount effect below tear the VAD down on every re-render.
  const captureStart = capture.start;
  const captureStop = capture.stop;
  const captureError = capture.error;
  const camera = useCameraFrame();
  // Stable fns (useCallback([])); the object identity churns each render.
  const cameraStart = camera.start;
  const cameraStop = camera.stop;
  const cameraGrab = camera.grabFrame;
  const cameraActive = camera.active;
  const cameraStream = camera.stream;
  const cameraError = camera.error;
  const [state, setState] = useState<VoiceState>("idle");
  const [lastAssistantText, setLastAssistantText] = useState("");
  const [visual, setVisual] = useState<VisualArtifact | null>(null);
  const [generating, setGenerating] = useState(false);

  // Rich output: artifacts already surfaced (so re-renders / re-entry don't
  // re-show them), a key for the marker we last flagged as "generating", and a
  // safety timer to clear a stuck generating state.
  const seenVisualsRef = useRef<Set<string>>(new Set());
  const generatingKeyRef = useRef<string | null>(null);
  const generatingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Read camera-on inside the stable send callback without re-creating it.
  const cameraActiveRef = useRef(false);
  cameraActiveRef.current = cameraActive;

  // The exact frame last sent to the AI, as an object URL (for the bottom
  // thumbnail). We own the URL's lifetime: revoke on replace / hide / unmount.
  const [lastSentFrameUrl, setLastSentFrameUrl] = useState<string | null>(null);
  const lastSentFrameUrlRef = useRef<string | null>(null);
  const sentFrameTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearSentFrame = useCallback(() => {
    clearTimeout(sentFrameTimerRef.current);
    if (lastSentFrameUrlRef.current) {
      URL.revokeObjectURL(lastSentFrameUrlRef.current);
      lastSentFrameUrlRef.current = null;
    }
    setLastSentFrameUrl(null);
  }, []);

  const showSentFrame = useCallback(
    (frame: File) => {
      if (typeof URL.createObjectURL !== "function") return;
      clearTimeout(sentFrameTimerRef.current);
      if (lastSentFrameUrlRef.current) {
        URL.revokeObjectURL(lastSentFrameUrlRef.current);
      }
      const url = URL.createObjectURL(frame);
      lastSentFrameUrlRef.current = url;
      setLastSentFrameUrl(url);
      sentFrameTimerRef.current = setTimeout(clearSentFrame, SENT_FRAME_TTL_MS);
    },
    [clearSentFrame],
  );

  const playedPathsRef = useRef<Set<string>>(new Set());
  const ignoredTurnIdsRef = useRef<Set<string>>(new Set());
  const activeTurnIdRef = useRef<string | null>(null);
  const speechInterruptArmedRef = useRef(false);
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stateRef = useRef<VoiceState>("idle");
  stateRef.current = state;
  // Latest threads, for reading inside stable callbacks without churning deps.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  // Thread count when this voice session started; used to suppress showing the
  // PREVIOUS turn's question/answer until a new turn happens this session.
  const turnBaselineRef = useRef(0);

  // Sentence-streamed reply audio: a FIFO queue of workspace-relative paths to
  // play in order, a "currently playing" flag, and a grace timer used to wait
  // for late sentences before returning to listening.
  const audioQueueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Stable refs that break the circular dependency between beginListening ↔
  // drainQueue. Each stores itself into its own ref every render.
  const beginListeningRef = useRef<() => Promise<void>>(async () => {});
  const beginThinkingInterruptRef = useRef<() => Promise<void>>(async () => {});
  const sendUtteranceRef = useRef<(wav: Blob) => Promise<void>>(async () => {});
  const drainQueueRef = useRef<() => Promise<void>>(async () => {});

  const releaseAudio = useCallback(() => {
    stopAudio();
  }, []);

  const requestTurnInterrupt = useCallback(
    (reason: string): boolean => {
      const turnId =
        activeTurnIdRef.current ??
        threadsRef.current.find(
          (t) =>
            t.pendingAssistant !== null &&
            t.pendingAssistant.status === "streaming",
        )?.id ??
        null;
      if (!turnId) return false;
      ignoredTurnIdsRef.current.add(turnId);
      if (activeTurnIdRef.current === turnId) {
        activeTurnIdRef.current = null;
      }
      void interruptActiveTurn({
        sessionId,
        historyTopic,
        turnId,
        reason,
      }).catch(() => {
        // Best-effort: local state has already moved on.
      });
      return true;
    },
    [historyTopic, sessionId],
  );

  const sendCapturedUtterance = useCallback(
    async (wav: Blob) => {
      try {
        const turnId = crypto.randomUUID();
        activeTurnIdRef.current = turnId;
        stateRef.current = "thinking";
        setState("thinking");
        const file = new File([wav], "utterance.wav", { type: "audio/wav" });
        // When the camera is on, attach the current frame so the turn is a
        // video call (audio + image); the server transcribes the audio and the
        // VLM sees the frame. Degrades to audio-only on a failed grab.
        const files = await assembleTurnFiles(
          file,
          cameraActiveRef.current,
          cameraGrab,
        );
        // Surface the exact image sent to the AI (the model's view).
        const sentFrame = files.find((f) => f.type.startsWith("image/"));
        if (sentFrame) showSentFrame(sentFrame);
        const paths = await uploadFiles(files, "recording");
        // The server-side STT transcribes the audio in `media` into the prompt.
        // The reply's TTS audio arrives asynchronously and is played by the
        // threads watcher below (not here in onComplete).
        sendMessage({
          sessionId,
          historyTopic,
          text: "",
          media: paths,
          clientMessageId: turnId,
          onComplete: () => {
            if (activeTurnIdRef.current === turnId) {
              activeTurnIdRef.current = null;
            }
          },
        });
        void beginThinkingInterruptRef.current();
        // Safety net: if no reply audio shows up in time, return to listening.
        clearTimeout(replyTimerRef.current);
        replyTimerRef.current = setTimeout(() => {
          if (stateRef.current === "thinking") {
            void beginListeningRef.current();
          }
        }, REPLY_TIMEOUT_MS);
      } catch (e) {
        console.error("[voice] upload/send failed", e);
        setState("error");
      }
    },
    [historyTopic, sessionId, cameraGrab, showSentFrame],
  );

  const beginThinkingInterrupt = useCallback(async () => {
    if (stateRef.current !== "thinking") return;
    speechInterruptArmedRef.current = false;
    await captureStart(
      (wav: Blob) => {
        if (!speechInterruptArmedRef.current) return;
        void captureStop();
        void sendUtteranceRef.current(wav);
      },
      {
        ...THINKING_INTERRUPT_VAD_OPTIONS,
        onSpeechRealStart: () => {
          if (
            speechInterruptArmedRef.current ||
            stateRef.current !== "thinking"
          ) {
            return;
          }
          speechInterruptArmedRef.current = true;
          clearTimeout(replyTimerRef.current);
          clearTimeout(graceTimerRef.current);
          audioQueueRef.current = [];
          requestTurnInterrupt("user started speaking while thinking");
        },
      },
    );
  }, [captureStart, captureStop, requestTurnInterrupt]);

  // Define beginListening and playReply with useCallback; each calls the other via its ref.

  const beginListening = useCallback(async () => {
    stateRef.current = "listening";
    setState("listening");
    await captureStart(
      (wav: Blob) => {
        // Ignore late utterances that land after we've left listening.
        if (stateRef.current !== "listening") return;
        void captureStop();
        void sendUtteranceRef.current(wav);
      },
      LISTENING_VAD_OPTIONS,
    );
  }, [captureStart, captureStop]);

  // Fetch + play ONE reply-audio file, resolving when playback ends. Does NOT
  // return to listening — `drainQueue` orchestrates ordering across sentences.
  const playOne = useCallback(
    async (path: string): Promise<void> => {
      try {
        // /api/files resolves workspace-relative paths only when scoped to a
        // session; pass ?session=<id> so the server can locate it.
        const fetchUrl = `${buildFileUrl(path)}?session=${encodeURIComponent(sessionId)}`;
        const resp = await fetch(fetchUrl, { headers: buildApiHeaders() });
        if (!resp.ok) {
          console.error("[voice] reply audio fetch failed", resp.status);
          return;
        }
        const blob = await resp.blob();
        stateRef.current = "speaking";
        setState("speaking");
        // Play through the autoplay-unlocked AudioContext (see audio-playback.ts);
        // resolve when playback ends, fails to start, OR decode/start throws —
        // otherwise a single bad clip wedges the queue in "speaking" forever.
        await new Promise<void>((resolve) => {
          playAudioBlob(blob, () => resolve())
            .then((started) => {
              if (!started) resolve();
            })
            .catch((e) => {
              console.error("[voice] reply playback failed", e);
              resolve();
            });
        });
      } catch (e) {
        console.error("[voice] reply playback failed", e);
      }
    },
    [sessionId],
  );

  // Play queued sentence audios in order. New sentences pushed during playback
  // are picked up by the loop. When the queue drains, wait a short grace window
  // for late sentences before returning to listening.
  const drainQueue = useCallback(async (): Promise<void> => {
    if (playingRef.current) return; // a drain loop is already running
    playingRef.current = true;
    try {
      while (audioQueueRef.current.length > 0) {
        const next = audioQueueRef.current.shift() as string;
        await playOne(next);
      }
    } finally {
      playingRef.current = false;
    }
    clearTimeout(graceTimerRef.current);
    graceTimerRef.current = setTimeout(() => {
      if (
        audioQueueRef.current.length === 0 &&
        !playingRef.current &&
        (stateRef.current === "speaking" || stateRef.current === "thinking")
      ) {
        void beginListeningRef.current();
      }
    }, 1500);
  }, [playOne]);

  // Keep refs up to date after every render so closures always call the latest version.
  beginListeningRef.current = beginListening;
  beginThinkingInterruptRef.current = beginThinkingInterrupt;
  sendUtteranceRef.current = sendCapturedUtterance;
  drainQueueRef.current = drainQueue;

  const start = useCallback(async () => {
    // Unlock audio playback now, while we're still close to the user's entry
    // gesture (the click that mounted the voice view). Replies arrive tens of
    // seconds later and would otherwise be blocked by the autoplay policy.
    unlockAudio();
    // Mark all PRE-EXISTING reply audio as already played, so re-entering voice
    // chat doesn't replay the previous turn's reply — only audio produced after
    // this point is picked up. (Previously only a browser refresh cleared it.)
    playedPathsRef.current = new Set(
      collectFreshAudio(
        threadsRef.current,
        new Set(),
        ignoredTurnIdsRef.current,
      ).map((a) => a.path),
    );
    ignoredTurnIdsRef.current = new Set();
    activeTurnIdRef.current = null;
    turnBaselineRef.current = threadsRef.current.length;
    setLastAssistantText("");
    // Rich output: mark pre-existing artifacts as seen so re-entry doesn't
    // re-surface a prior turn's visual; reset the live visual/generating state.
    seenVisualsRef.current = new Set(
      collectFreshVisuals(
        threadsRef.current,
        new Set(),
        ignoredTurnIdsRef.current,
      ).map((v) => v.path),
    );
    setVisual(null);
    setGenerating(false);
    generatingKeyRef.current = null;
    clearTimeout(generatingTimerRef.current);
    audioQueueRef.current = [];
    playingRef.current = false;
    clearTimeout(graceTimerRef.current);
    // Wait for the WS bridge to actually connect before we start listening.
    // Otherwise a fast first utterance races the (re)connect and the turn
    // never reaches the server — the "you must wait a few seconds after a
    // refresh" footgun. Poll the runtime's active-bridge connection state;
    // proceed anyway after a ceiling so a missing bridge can't wedge us.
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const b = getActiveBridge(sessionId, historyTopic);
      if (b?.getConnectionState?.() === "connected") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await beginListening();
  }, [beginListening, sessionId, historyTopic]);

  const stop = useCallback(() => {
    clearTimeout(replyTimerRef.current);
    clearTimeout(graceTimerRef.current);
    activeTurnIdRef.current = null;
    speechInterruptArmedRef.current = false;
    audioQueueRef.current = [];
    playingRef.current = false;
    clearTimeout(generatingTimerRef.current);
    generatingKeyRef.current = null;
    setVisual(null);
    setGenerating(false);
    void captureStop();
    cameraStop();
    clearSentFrame();
    releaseAudio();
    stateRef.current = "idle";
    setState("idle");
  }, [captureStop, cameraStop, clearSentFrame, releaseAudio]);

  const toggleCamera = useCallback(() => {
    if (cameraActiveRef.current) {
      cameraStop();
    } else {
      void cameraStart();
    }
  }, [cameraStart, cameraStop]);

  const interrupt = useCallback(() => {
    if (stateRef.current === "speaking") {
      audioQueueRef.current = [];
      clearTimeout(graceTimerRef.current);
      releaseAudio();
      void beginListeningRef.current();
    } else if (stateRef.current === "thinking") {
      clearTimeout(replyTimerRef.current);
      clearTimeout(graceTimerRef.current);
      audioQueueRef.current = [];
      speechInterruptArmedRef.current = false;
      requestTurnInterrupt("user tapped orb while thinking");
      void captureStop();
      void beginListeningRef.current();
    }
  }, [captureStop, releaseAudio, requestTurnInterrupt]);

  useEffect(() => {
    if (captureError) setState("error");
  }, [captureError]);

  // Play the assistant's TTS audio as soon as it lands in the thread, decoupled
  // from turn/completed timing (TTS is produced post-reply and can arrive
  // seconds after the turn completes). Only acts while "thinking".
  useEffect(() => {
    if (state !== "thinking" && state !== "speaking") return;
    const fresh = collectFreshAudio(
      threads,
      playedPathsRef.current,
      ignoredTurnIdsRef.current,
    );
    if (fresh.length === 0) return;
    speechInterruptArmedRef.current = false;
    activeTurnIdRef.current = null;
    clearTimeout(replyTimerRef.current);
    clearTimeout(graceTimerRef.current);
    // Mark + enqueue synchronously so a re-render mid-teardown doesn't
    // re-collect the same audio.
    for (const f of fresh) {
      playedPathsRef.current.add(f.path);
      audioQueueRef.current.push(f.path);
      setLastAssistantText(stripVisualMarker(f.text));
    }
    // Tear the barge-in VAD down and WAIT for it to finish BEFORE playback, so
    // its Silero ONNX/WASM + mic AudioContext shutdown doesn't contend with the
    // reply's Web Audio render thread (that contention glitched the first
    // sentence). drainQueue is guarded by playingRef against concurrent runs.
    void (async () => {
      await captureStop();
      await drainQueueRef.current();
    })();
  }, [captureStop, threads, state]);

  // Rich output: surface visual artifacts as they land (decoupled from turn
  // timing — HTML authoring / image gen can finish seconds after the reply),
  // and reflect a "generating" state while a marker is seen but no artifact has
  // arrived yet. Not gated on voice state, so a late artifact is still caught.
  useEffect(() => {
    const fresh = collectFreshVisuals(
      threads,
      seenVisualsRef.current,
      ignoredTurnIdsRef.current,
    );
    if (fresh.length > 0) {
      for (const v of fresh) seenVisualsRef.current.add(v.path);
      setVisual(fresh[fresh.length - 1]);
      setGenerating(false);
      generatingKeyRef.current = null;
      clearTimeout(generatingTimerRef.current);
      return;
    }
    // No artifact yet: if the newest post-baseline assistant reply carries a
    // marker we haven't flagged, enter the generating state (with a safety
    // timeout so a failed generation can't wedge it on forever).
    for (let i = threads.length - 1; i >= turnBaselineRef.current; i--) {
      const t = threads[i];
      if (!t) continue;
      const asst = t.responses.filter((m) => m.role === "assistant");
      const text = asst.length > 0 ? asst[asst.length - 1].text : "";
      if (text && hasVisualMarker(text)) {
        if (generatingKeyRef.current !== text) {
          generatingKeyRef.current = text;
          setGenerating(true);
          clearTimeout(generatingTimerRef.current);
          generatingTimerRef.current = setTimeout(
            () => setGenerating(false),
            VISUAL_TIMEOUT_MS,
          );
        }
        break;
      }
    }
  }, [threads]);

  // Stop ONLY on real unmount. Use a ref so identity churn of `stop` across
  // re-renders never re-fires this cleanup (that was tearing the VAD down on
  // every render). `[]` deps → cleanup runs once, at unmount.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => stopRef.current(), []);

  const lastUserText =
    threads.length > turnBaselineRef.current
      ? (threads[threads.length - 1].userMsg?.text ?? "")
      : "";

  const dismissVisual = useCallback(() => setVisual(null), []);

  return {
    state,
    lastUserText,
    lastAssistantText,
    error: capture.error,
    start,
    stop,
    interrupt,
    cameraActive,
    cameraStream,
    lastSentFrameUrl,
    cameraError,
    toggleCamera,
    visual,
    generating,
    dismissVisual,
  };
}
