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
  turns: VoiceConversationTurn[];
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
  /** UPCR-2026-025: true once an exit intent fired; the view shows a farewell
   *  while the last reply audio finishes, then navigates home. */
  exiting: boolean;
}

export interface VoiceConversationTurn {
  id: string;
  userText: string;
  assistantText: string;
  awaitingTranscript: boolean;
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
const SPEAKING_INTERRUPT_VAD_OPTIONS = {
  positiveSpeechThreshold: 0.68,
  negativeSpeechThreshold: 0.48,
  minSpeechMs: 620,
  redemptionMs: 700,
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
  return collectFreshAudioWithTurnIds(threads, played, ignoredThreadIds).map(
    ({ path, text }) => ({ path, text }),
  );
}

export function collectFreshAudioWithTurnIds(
  threads: Thread[],
  played: Set<string>,
  ignoredThreadIds: Set<string> = new Set(),
): { path: string; text: string; turnId: string }[] {
  const out: { path: string; text: string; turnId: string }[] = [];
  for (let i = 0; i < threads.length; i++) {
    if (ignoredThreadIds.has(threads[i].id)) continue;
    const asst = threads[i].responses.filter(
      (m: ThreadMessage) => m.role === "assistant",
    );
    for (let j = 0; j < asst.length; j++) {
      for (const f of asst[j].files) {
        if (AUDIO_EXT.test(f.path) && !played.has(f.path)) {
          out.push({ path: f.path, text: asst[j].text, turnId: threads[i].id });
        }
      }
    }
  }
  return out;
}

export function buildVoiceTurns(
  threads: Thread[],
  baseline = 0,
): VoiceConversationTurn[] {
  return threads.slice(baseline).map((thread) => {
    const assistants: ThreadMessage[] = [
      ...thread.responses.filter((m) => m.role === "assistant"),
      ...(thread.pendingAssistant ? [thread.pendingAssistant] : []),
    ];
    const assistantText = stripVisualMarker(
      [...assistants].reverse().find((m) => m.text.trim().length > 0)?.text ?? "",
    );
    const userText = thread.userMsg.text.trim();
    const awaitingTranscript =
      userText.length === 0 &&
      thread.userMsg.files.some((f) => AUDIO_EXT.test(f.path));
    return {
      id: thread.id,
      userText,
      assistantText,
      awaitingTranscript,
    };
  });
}

const HTML_EXT = /\.html?$/i;
const VISUAL_IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
/** Mirror of the backend in-band marker `[[VISUAL:kind|brief]]`. */
const VISUAL_MARKER = /\[\[VISUAL:(html|illustrated|image|infographic)\|([^\]]*)\]\]/;
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

/**
 * UPCR-2026-025: whether a `crew:voice_exit` event should be acted on. It must
 * target THIS voice session AND carry a turn id we have not already consumed —
 * guarding against ledger replays / duplicate events (re-delivered on reconnect)
 * re-triggering navigation for an already-handled turn. Exported for unit tests.
 */
export function shouldHandleExitEvent(
  detail: { sessionId?: string; turnId?: string } | undefined,
  sessionId: string,
  consumed: Set<string>,
): boolean {
  if (!detail || detail.sessionId !== sessionId) return false;
  const turnId = typeof detail.turnId === "string" ? detail.turnId : "";
  if (turnId && consumed.has(turnId)) return false;
  return true;
}

export function shouldHandleNoSpeechEvent(
  detail: { sessionId?: string; topic?: string; threadId?: string; turnId?: string } | undefined,
  sessionId: string,
  topic: string | undefined,
  activeTurnId: string | null,
): boolean {
  if (!detail || detail.sessionId !== sessionId) return false;
  if ((detail.topic ?? undefined) !== (topic ?? undefined)) return false;
  const eventTurnId = detail.threadId ?? detail.turnId ?? "";
  return activeTurnId === null || eventTurnId === activeTurnId;
}

/**
 * UPCR-2026-025: whether a farewell clip is still actively playing or queued —
 * i.e. the goodbye may still be heard, so navigation must wait for the
 * drainQueue grace-timer rather than be forced by the fallback timer. Note this
 * deliberately does NOT treat `thinking` as active: a turn that produced NO
 * farewell audio sits in `thinking`, and the fallback must still leave there.
 * Exported for unit tests.
 */
export function farewellAudioActive(
  playing: boolean,
  queueLength: number,
  state: VoiceState,
): boolean {
  return playing || queueLength > 0 || state === "speaking";
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
  /** UPCR-2026-025: called to leave the voice screen (e.g. navigate('/')) when
   *  the user expresses an exit intent — invoked AFTER the farewell audio. */
  onExit?: () => void,
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
  const [exiting, setExiting] = useState(false);

  // Rich output: artifacts already surfaced (so re-renders / re-entry don't
  // re-show them), the `turn_id` of the visual currently shown as "generating"
  // (#1477 — so only THAT turn's failure / artifact clears the placeholder, not
  // a stale sibling turn's), and a safety timer to clear a stuck state.
  const seenVisualsRef = useRef<Set<string>>(new Set());
  const generatingTurnRef = useRef<string | null>(null);
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
  // Which callback/threshold set the single live MicVAD is currently using.
  // A streamed reply can contain dozens of audio files; keep the `speaking`
  // capture mode across clip boundaries instead of re-running captureStart()
  // for every file.
  const captureModeRef = useRef<"listening" | "thinking" | "speaking" | null>(null);
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stateRef = useRef<VoiceState>("idle");
  stateRef.current = state;
  // Latest threads, for reading inside stable callbacks without churning deps.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  // Thread count when this voice session started; used to suppress showing the
  // PREVIOUS turn's question/answer until a new turn happens this session.
  const turnBaselineRef = useRef(0);
  const [turnBaseline, setTurnBaseline] = useState(0);

  // Sentence-streamed reply audio: a FIFO queue of workspace-relative paths to
  // play in order, a "currently playing" flag, and a grace timer used to wait
  // for late sentences before returning to listening.
  const audioQueueRef = useRef<string[]>([]);
  const audioTurnByPathRef = useRef<Map<string, string>>(new Map());
  const speakingTurnIdRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Drain-loop supersession token. interrupt()/stop() bump it after clearing
  // the queue; a drain loop whose generation no longer matches was superseded
  // mid-clip (its playOne resolved via stopAudio) and must NOT schedule the
  // return-to-listening grace timer — the interrupt path has already chosen
  // the next state, and a stale 1.5s timer could otherwise catch the user's
  // follow-up turn in `thinking` and knock it back to listening.
  const drainGenRef = useRef(0);

  // Voice exit intent (UPCR-2026-025): a `crew:voice_exit` DOM event sets
  // `exitPendingRef`; the drainQueue grace-timer then leaves /voice AFTER the
  // farewell audio finishes (so the goodbye is heard). `exitedRef` guards the
  // one-shot teardown; `exitFallbackTimerRef` is a safety net for a missing /
  // late farewell. `onExitRef` holds the latest navigation callback;
  // `performExitRef` breaks the cycle with `stop` (set after `stop` each render).
  const exitPendingRef = useRef(false);
  const exitedRef = useRef(false);
  const exitFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Turn ids whose `voice/exit` we've already acted on — dedups ledger replays /
  // duplicate events so a stale exit can't re-trigger navigation.
  const consumedExitTurnsRef = useRef<Set<string>>(new Set());
  const onExitRef = useRef<(() => void) | undefined>(undefined);
  onExitRef.current = onExit;
  const performExitRef = useRef<() => void>(() => {});

  // Cancellation token for start()'s async bridge-connect wait (same idiom
  // as use-voice-capture's startGenRef). stop() bumps it; start() re-checks
  // after every await, so leaving /voice mid-poll can never reach
  // beginListening() after teardown — that re-acquired the microphone under
  // a fresh VAD generation nothing tears down (post-unmount mic leak).
  const startGenRef = useRef(0);

  // Stable refs that break the circular dependency between beginListening ↔
  // drainQueue. Each stores itself into its own ref every render.
  const beginListeningRef = useRef<() => Promise<void>>(async () => {});
  const beginBargeInRef = useRef<() => Promise<void>>(async () => {});
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
          // #1478: this turn carries a live camera frame iff one was actually
          // attached (camera on + grab succeeded) — tell the server so it
          // treats the frame as a real-time view, never inferred from media.
          liveVideo: sentFrame !== undefined,
          onComplete: () => {
            if (activeTurnIdRef.current === turnId) {
              activeTurnIdRef.current = null;
            }
          },
        });
        void beginBargeInRef.current();
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

  const beginBargeIn = useCallback(async () => {
    if (stateRef.current !== "thinking" && stateRef.current !== "speaking") return;
    const captureMode = stateRef.current;
    if (captureModeRef.current === captureMode) return;
    captureModeRef.current = captureMode;
    speechInterruptArmedRef.current = false;
    const vadOptions =
      captureMode === "speaking"
        ? SPEAKING_INTERRUPT_VAD_OPTIONS
        : THINKING_INTERRUPT_VAD_OPTIONS;
    await captureStart(
      (wav: Blob) => {
        if (
          !speechInterruptArmedRef.current ||
          (stateRef.current !== "thinking" && stateRef.current !== "speaking")
        ) {
          return;
        }
        captureModeRef.current = null;
        void captureStop();
        void sendUtteranceRef.current(wav);
      },
      {
        ...vadOptions,
        onSpeechConfirmed: () => {
          if (
            speechInterruptArmedRef.current ||
            (stateRef.current !== "thinking" && stateRef.current !== "speaking")
          ) {
            return;
          }
          speechInterruptArmedRef.current = true;
          clearTimeout(replyTimerRef.current);
          clearTimeout(graceTimerRef.current);
          if (stateRef.current === "speaking") {
            const turnId = speakingTurnIdRef.current;
            if (turnId) ignoredTurnIdsRef.current.add(turnId);
            drainGenRef.current++;
            releaseAudio();
          } else {
            requestTurnInterrupt("user started speaking while thinking");
          }
          audioQueueRef.current = [];
          audioTurnByPathRef.current.clear();
          speakingTurnIdRef.current = null;
        },
        onVADMisfire: () => {
          speechInterruptArmedRef.current = false;
        },
      },
    );
  }, [captureStart, captureStop, releaseAudio, requestTurnInterrupt]);

  // Define beginListening and playReply with useCallback; each calls the other via its ref.

  const beginListening = useCallback(async () => {
    stateRef.current = "listening";
    setState("listening");
    captureModeRef.current = "listening";
    await captureStart(
      (wav: Blob) => {
        // Ignore late utterances that land after we've left listening.
        if (stateRef.current !== "listening") return;
        captureModeRef.current = null;
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
        await beginBargeInRef.current();
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
    const drainGen = drainGenRef.current;
    playingRef.current = true;
    try {
      while (audioQueueRef.current.length > 0) {
        const next = audioQueueRef.current.shift() as string;
        speakingTurnIdRef.current = audioTurnByPathRef.current.get(next) ?? null;
        await playOne(next);
        audioTurnByPathRef.current.delete(next);
        speakingTurnIdRef.current = null;
      }
    } finally {
      playingRef.current = false;
    }
    // interrupt()/stop() superseded this drain while a clip was in flight —
    // they already chose the next state (listening / idle), so scheduling the
    // grace timer here would be stale (and could later beginListening() into
    // the follow-up turn's `thinking`).
    if (drainGenRef.current !== drainGen) return;
    clearTimeout(graceTimerRef.current);
    graceTimerRef.current = setTimeout(() => {
      if (
        audioQueueRef.current.length === 0 &&
        !playingRef.current &&
        (stateRef.current === "speaking" || stateRef.current === "thinking")
      ) {
        // UPCR-2026-025: the farewell audio has finished — if an exit intent is
        // pending, leave /voice now instead of returning to listening.
        if (exitPendingRef.current) {
          performExitRef.current();
        } else {
          void beginListeningRef.current();
        }
      }
    }, 1500);
  }, [playOne]);

  // Keep refs up to date after every render so closures always call the latest version.
  beginListeningRef.current = beginListening;
  beginBargeInRef.current = beginBargeIn;
  sendUtteranceRef.current = sendCapturedUtterance;
  drainQueueRef.current = drainQueue;

  const start = useCallback(async () => {
    // Capture this start's generation. A later stop() (unmount, exit) or a
    // newer start() bumps the counter; every await below re-checks it and
    // abandons, so a stale start can never re-acquire the microphone.
    const gen = ++startGenRef.current;
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
    captureModeRef.current = null;
    turnBaselineRef.current = threadsRef.current.length;
    setTurnBaseline(threadsRef.current.length);
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
    generatingTurnRef.current = null;
    clearTimeout(generatingTimerRef.current);
    audioQueueRef.current = [];
    audioTurnByPathRef.current.clear();
    speakingTurnIdRef.current = null;
    playingRef.current = false;
    clearTimeout(graceTimerRef.current);
    // UPCR-2026-025: a fresh start clears any prior exit-pending state (e.g. an
    // error-retry re-entry); a real exit unmounts the view so this never undoes
    // an in-flight navigation.
    exitPendingRef.current = false;
    exitedRef.current = false;
    clearTimeout(exitFallbackTimerRef.current);
    setExiting(false);
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
      // stop() ran while we were waiting (the user left /voice) — abandon
      // before beginListening() re-acquires the mic with no owner left to
      // tear it down.
      if (startGenRef.current !== gen) return;
    }
    if (startGenRef.current !== gen) return;
    await beginListening();
  }, [beginListening, sessionId, historyTopic]);

  const stop = useCallback(() => {
    // Invalidate any in-flight start() (it re-checks this after each await).
    startGenRef.current++;
    // Supersede any suspended drain loop so it exits without scheduling a
    // stale grace timer (releaseAudio() below resolves its awaited clip).
    drainGenRef.current++;
    clearTimeout(replyTimerRef.current);
    clearTimeout(graceTimerRef.current);
    activeTurnIdRef.current = null;
    speechInterruptArmedRef.current = false;
    captureModeRef.current = null;
    audioQueueRef.current = [];
    audioTurnByPathRef.current.clear();
    speakingTurnIdRef.current = null;
    playingRef.current = false;
    clearTimeout(generatingTimerRef.current);
    generatingTurnRef.current = null;
    setVisual(null);
    setGenerating(false);
    clearTimeout(exitFallbackTimerRef.current);
    void captureStop();
    cameraStop();
    clearSentFrame();
    releaseAudio();
    stateRef.current = "idle";
    setState("idle");
  }, [captureStop, cameraStop, clearSentFrame, releaseAudio]);

  // Leave the voice screen: one-shot. Tears down capture/audio/camera, then
  // invokes the navigation callback (e.g. navigate('/')). Called from the exit
  // event (already-idle case), the drain grace-timer (after the farewell), or
  // the fallback timer — `exitedRef` makes the duplicate calls no-ops.
  const performExit = useCallback(() => {
    if (exitedRef.current) return;
    exitedRef.current = true;
    exitPendingRef.current = false;
    clearTimeout(exitFallbackTimerRef.current);
    stop();
    onExitRef.current?.();
  }, [stop]);
  performExitRef.current = performExit;

  const toggleCamera = useCallback(() => {
    if (cameraActiveRef.current) {
      cameraStop();
    } else {
      void cameraStart();
    }
  }, [cameraStart, cameraStop]);

  const interrupt = useCallback(() => {
    if (stateRef.current === "speaking") {
      const turnId = speakingTurnIdRef.current;
      if (turnId) ignoredTurnIdsRef.current.add(turnId);
      audioQueueRef.current = [];
      audioTurnByPathRef.current.clear();
      speakingTurnIdRef.current = null;
      // Supersede the drain loop BEFORE releaseAudio() resolves its awaited
      // clip: when it resumes it must exit without scheduling a stale grace
      // timer — we return to listening right here.
      drainGenRef.current++;
      clearTimeout(graceTimerRef.current);
      releaseAudio();
      void beginListeningRef.current();
    } else if (stateRef.current === "thinking") {
      clearTimeout(replyTimerRef.current);
      clearTimeout(graceTimerRef.current);
      audioQueueRef.current = [];
      audioTurnByPathRef.current.clear();
      speakingTurnIdRef.current = null;
      // A drain loop can be alive in `thinking` too (its first clip is still
      // in the fetch phase) — supersede it the same way.
      drainGenRef.current++;
      speechInterruptArmedRef.current = false;
      requestTurnInterrupt("user tapped orb while thinking");
      captureModeRef.current = null;
      void captureStop();
      void beginListeningRef.current();
    }
  }, [captureStop, releaseAudio, requestTurnInterrupt]);

  useEffect(() => {
    if (captureError) {
      captureModeRef.current = null;
      setState("error");
    }
  }, [captureError]);

  // Play the assistant's TTS audio as soon as it lands in the thread, decoupled
  // from turn/completed timing (TTS is produced post-reply and can arrive
  // seconds after the turn completes). Only acts while "thinking".
  useEffect(() => {
    if (state !== "thinking" && state !== "speaking") return;
    const fresh = collectFreshAudioWithTurnIds(
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
      audioTurnByPathRef.current.set(f.path, f.turnId);
      audioQueueRef.current.push(f.path);
      setLastAssistantText(stripVisualMarker(f.text));
    }
    // Keep the barge-in VAD alive while reply audio plays so the user can
    // interrupt by speaking. drainQueue is guarded by playingRef against
    // concurrent runs.
    void drainQueueRef.current();
  }, [threads, state]);

  // Rich output: surface visual artifacts as they land (decoupled from turn
  // timing — HTML authoring / image gen can finish seconds after the reply).
  // Only SHOWS the latest artifact here; clearing the "generating" placeholder
  // is turn-attributed in the typed-event effect below (#1477), so a late
  // artifact from an EARLIER turn does not clear a newer turn's placeholder.
  useEffect(() => {
    const fresh = collectFreshVisuals(
      threads,
      seenVisualsRef.current,
      ignoredTurnIdsRef.current,
    );
    if (fresh.length > 0) {
      for (const v of fresh) seenVisualsRef.current.add(v.path);
      setVisual(fresh[fresh.length - 1]);
    }
  }, [threads]);

  // #1477 voice rich output: drive the "generating" placeholder off the typed
  // visual lifecycle events instead of scraping an in-band `[[VISUAL:...]]`
  // marker out of the assistant text (the backend no longer puts that marker on
  // the wire). The placeholder is ATTRIBUTED to a turn_id: only the active
  // turn's own success (`visual/succeeded`), failure (`visual/failed`), or the
  // safety timeout clears it — so if visual A is still generating when the user
  // starts visual B, A's late success/failure never clears B's placeholder.
  // Success is a dedicated typed event, NOT inferred from `file/attached`.
  // Consume the router's `crew:visual_*` DOM events rather than subscribing to
  // the bridge directly. The router is attached AT bridge startup (before the
  // bridge becomes `active`) and re-attaches on reconnect, so a window listener
  // never races the async bridge start — a direct `getActiveBridge(...)`
  // subscription here ran at mount, found no bridge yet, bailed, and never
  // re-ran, so the placeholder never showed (#1477 follow-up). Filtered by
  // sessionId; attributed by turn_id so a stale turn's success/failure cannot
  // clear a newer turn's placeholder.
  useEffect(() => {
    const forThisSession = (d: unknown): d is { sessionId: string; turnId: string } =>
      !!d &&
      typeof d === "object" &&
      (d as { sessionId?: unknown }).sessionId === sessionId;
    const clearForTurn = (turnId: string) => {
      if (generatingTurnRef.current !== turnId) return;
      setGenerating(false);
      generatingTurnRef.current = null;
      clearTimeout(generatingTimerRef.current);
    };
    const onGenerating = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      if (!forThisSession(d)) return;
      generatingTurnRef.current = d.turnId;
      setGenerating(true);
      clearTimeout(generatingTimerRef.current);
      generatingTimerRef.current = setTimeout(() => {
        // Safety net only — the active turn's success/failure never arrived.
        setGenerating(false);
        generatingTurnRef.current = null;
      }, VISUAL_TIMEOUT_MS);
    };
    const onResolved = (ev: Event) => {
      const d = (ev as CustomEvent).detail;
      if (forThisSession(d)) clearForTurn(d.turnId);
    };
    // Success + failure are both typed lifecycle events (#1477); the
    // placeholder is never cleared by inferring success from a `file/attached`
    // file extension.
    window.addEventListener("crew:visual_generating", onGenerating);
    window.addEventListener("crew:visual_succeeded", onResolved);
    window.addEventListener("crew:visual_failed", onResolved);
    return () => {
      window.removeEventListener("crew:visual_generating", onGenerating);
      window.removeEventListener("crew:visual_succeeded", onResolved);
      window.removeEventListener("crew:visual_failed", onResolved);
    };
  }, [sessionId]);

  // Voice exit intent (UPCR-2026-025): consume the router's `crew:voice_exit`
  // DOM event (filtered by sessionId). Mark exit pending + show the farewell
  // state; the drainQueue grace-timer performs the navigation after the reply
  // audio drains, so the goodbye is heard first. If nothing is queued/playing
  // (the farewell already finished, or the model sent no audio), leave now. A
  // fallback timer covers the case where reply audio never arrives. Listening on
  // `window` (not the bridge) avoids racing the async bridge start — the router
  // re-attaches on reconnect and keeps dispatching (mirrors the visual hook).
  useEffect(() => {
    const EXIT_FALLBACK_MS = 8000;
    const onExitEvent = (ev: Event) => {
      const d = (ev as CustomEvent).detail as
        | { sessionId?: string; turnId?: string }
        | undefined;
      // Filter by session AND dedup by turn id (replay / duplicate guard).
      if (!shouldHandleExitEvent(d, sessionId, consumedExitTurnsRef.current)) {
        return;
      }
      const turnId = typeof d?.turnId === "string" ? d.turnId : "";
      if (turnId) consumedExitTurnsRef.current.add(turnId);
      exitPendingRef.current = true;
      setExiting(true);
      // If a farewell is playing/queued OR the reply is still arriving
      // (`thinking`), wait — the drainQueue grace-timer leaves after the audio
      // drains. Otherwise (idle/listening, nothing in flight) the farewell is
      // already done or never came, so leave now.
      const inFlight =
        farewellAudioActive(
          playingRef.current,
          audioQueueRef.current.length,
          stateRef.current,
        ) || stateRef.current === "thinking";
      if (!inFlight) {
        performExitRef.current();
        return;
      }
      clearTimeout(exitFallbackTimerRef.current);
      exitFallbackTimerRef.current = setTimeout(() => {
        if (!exitPendingRef.current) return;
        // Review fix: a farewell may still be playing/queued past the fallback
        // window (slow fetch/decode, long clip). Do NOT cut it off — defer to
        // the drainQueue grace-timer, which performExit()s once the audio
        // drains. Only force-exit when nothing is in flight (e.g. the model
        // produced no farewell audio at all, so the turn is stuck in `thinking`
        // with an empty queue).
        if (
          farewellAudioActive(
            playingRef.current,
            audioQueueRef.current.length,
            stateRef.current,
          )
        ) {
          return;
        }
        performExitRef.current();
      }, EXIT_FALLBACK_MS);
    };
    window.addEventListener("crew:voice_exit", onExitEvent);
    return () => window.removeEventListener("crew:voice_exit", onExitEvent);
  }, [sessionId]);

  useEffect(() => {
    const onNoSpeech = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | {
            sessionId?: string;
            topic?: string;
            turnId?: string;
            threadId?: string;
          }
        | undefined;
      if (
        !shouldHandleNoSpeechEvent(
          detail,
          sessionId,
          historyTopic,
          activeTurnIdRef.current,
        )
      ) {
        return;
      }
      clearTimeout(replyTimerRef.current);
      clearTimeout(graceTimerRef.current);
      activeTurnIdRef.current = null;
      speechInterruptArmedRef.current = false;
      audioQueueRef.current = [];
      audioTurnByPathRef.current.clear();
      speakingTurnIdRef.current = null;
      if (stateRef.current === "thinking") {
        void beginListeningRef.current();
      }
    };
    window.addEventListener("crew:voice_no_speech", onNoSpeech);
    return () => window.removeEventListener("crew:voice_no_speech", onNoSpeech);
  }, [historyTopic, sessionId]);

  // Stop ONLY on real unmount. Use a ref so identity churn of `stop` across
  // re-renders never re-fires this cleanup (that was tearing the VAD down on
  // every render). `[]` deps → cleanup runs once, at unmount.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => stopRef.current(), []);

  const lastUserText =
    threads.length > turnBaseline
      ? (threads[threads.length - 1].userMsg?.text ?? "")
      : "";
  const turns = buildVoiceTurns(threads, turnBaseline);

  const dismissVisual = useCallback(() => setVisual(null), []);

  return {
    state,
    lastUserText,
    lastAssistantText,
    turns,
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
    exiting,
  };
}
