/**
 * Autoplay-safe audio playback for the voice assistant.
 *
 * `HTMLAudioElement.play()` invoked from a network callback — seconds after
 * the last user gesture — is blocked by the browser autoplay policy
 * (NotAllowedError), especially on Safari. The voice reply audio arrives tens
 * of seconds after the user entered voice mode, so it always hit that wall.
 *
 * Instead we route playback through a single Web Audio `AudioContext` that we
 * `resume()` during the user's ENTRY gesture (`unlockAudio`). Once unlocked,
 * the context plays decoded buffers at any later time with no per-play gesture
 * required.
 */

let ctx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;
// Completion callback for `current`, kept alongside it so `stopAudio` can
// fire it on interrupt. `playOne` (use-voice-conversation.ts) awaits this
// callback; orphaning it wedges the reply drain loop's `playingRef` latch
// and permanently silences every later reply.
let currentOnEnded: (() => void) | null = null;

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Call from inside a user-gesture handler (the entry click / orb tap) to
 *  unlock playback for the rest of the session. */
export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === "suspended") void c.resume();
}

/** Stop whatever is currently playing. Fires the interrupted clip's
 *  `onEnded` callback (exactly once) so callers awaiting playback
 *  completion resolve — nulling the handler without invoking it left
 *  `playOne`'s promise pending forever and no later reply ever played. */
export function stopAudio(): void {
  if (!current) return;
  const src = current;
  const onEnded = currentOnEnded;
  current = null;
  currentOnEnded = null;
  // Detach the DOM handler first: stop() makes the source fire `ended`
  // asynchronously, and we invoke the completion callback ourselves below —
  // detaching keeps it to exactly one invocation.
  src.onended = null;
  try {
    src.stop();
  } catch {
    // already stopped / ended
  }
  onEnded?.();
}

/** Decode + play an audio blob through the unlocked context. Resolves true if
 *  playback started, false if Web Audio is unavailable. `onEnded` fires
 *  exactly once per started clip — when it finishes, when it is interrupted
 *  via `stopAudio`, or when a newer clip supersedes it. Throws if decode or
 *  start fails — caller handles fallback. */
export async function playAudioBlob(
  blob: Blob,
  onEnded: () => void,
): Promise<boolean> {
  const c = getCtx();
  if (!c) return false;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      // continue — decode/start may still succeed (or throw to the caller)
    }
  }
  const arrayBuf = await blob.arrayBuffer();
  const audioBuf = await c.decodeAudioData(arrayBuf);
  stopAudio();
  const src = c.createBufferSource();
  src.buffer = audioBuf;
  src.connect(c.destination);
  src.onended = () => {
    if (current === src) {
      current = null;
      currentOnEnded = null;
    }
    onEnded();
  };
  current = src;
  currentOnEnded = onEnded;
  src.start();
  return true;
}
