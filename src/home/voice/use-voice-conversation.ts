import { useCallback, useEffect, useRef, useState } from "react";
import { uploadFiles } from "@/api/chat";
import { sendMessage } from "@/runtime/ui-protocol-send";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import { useThreads, type Thread, type ThreadMessage } from "@/store/thread-store";
import { buildFileUrl } from "@/api/files";
import { buildApiHeaders } from "@/api/client";
import { useVoiceCapture } from "./use-voice-capture";
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
}

const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|flac)$/i;

/** Safety net: if no reply audio shows up within this window after sending,
 *  return to listening. On-device ominix can thrash ASR↔TTS model reloads
 *  under memory pressure (tens of seconds each), so this is deliberately
 *  generous; cloud STT/TTS or more RAM would let us shrink it. */
const REPLY_TIMEOUT_MS = 90000;

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
): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (let i = 0; i < threads.length; i++) {
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
  const [state, setState] = useState<VoiceState>("idle");
  const [lastAssistantText, setLastAssistantText] = useState("");

  const playedPathsRef = useRef<Set<string>>(new Set());
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
  const drainQueueRef = useRef<() => Promise<void>>(async () => {});

  const releaseAudio = useCallback(() => {
    stopAudio();
  }, []);

  // Define beginListening and playReply with useCallback; each calls the other via its ref.

  const beginListening = useCallback(async () => {
    setState("listening");
    await captureStart((wav: Blob) => {
      // Ignore late utterances that land after we've left listening.
      if (stateRef.current !== "listening") return;
      captureStop();
      setState("thinking");
      void (async () => {
        try {
          const file = new File([wav], "utterance.wav", { type: "audio/wav" });
          const paths = await uploadFiles([file], "recording");
          // Audio-only turn: the server-side STT transcribes `media` into the
          // prompt. The reply's TTS audio arrives asynchronously and is played
          // by the threads watcher below (not here in onComplete).
          sendMessage({ sessionId, historyTopic, text: "", media: paths });
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
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureStart, captureStop, sessionId, historyTopic]);

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
      collectFreshAudio(threadsRef.current, new Set()).map((a) => a.path),
    );
    turnBaselineRef.current = threadsRef.current.length;
    setLastAssistantText("");
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
    audioQueueRef.current = [];
    playingRef.current = false;
    captureStop();
    releaseAudio();
    setState("idle");
  }, [captureStop, releaseAudio]);

  const interrupt = useCallback(() => {
    if (stateRef.current === "speaking") {
      audioQueueRef.current = [];
      clearTimeout(graceTimerRef.current);
      releaseAudio();
      void beginListeningRef.current();
    }
  }, [releaseAudio]);

  useEffect(() => {
    if (captureError) setState("error");
  }, [captureError]);

  // Play the assistant's TTS audio as soon as it lands in the thread, decoupled
  // from turn/completed timing (TTS is produced post-reply and can arrive
  // seconds after the turn completes). Only acts while "thinking".
  useEffect(() => {
    if (state !== "thinking" && state !== "speaking") return;
    const fresh = collectFreshAudio(threads, playedPathsRef.current);
    if (fresh.length === 0) return;
    clearTimeout(replyTimerRef.current);
    clearTimeout(graceTimerRef.current);
    for (const f of fresh) {
      playedPathsRef.current.add(f.path);
      audioQueueRef.current.push(f.path);
      setLastAssistantText(f.text);
    }
    void drainQueueRef.current();
  }, [threads, state]);

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

  return {
    state,
    lastUserText,
    lastAssistantText,
    error: capture.error,
    start,
    stop,
    interrupt,
  };
}
