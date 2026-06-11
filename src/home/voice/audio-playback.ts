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

/** Stop whatever is currently playing. */
export function stopAudio(): void {
  if (current) {
    try {
      current.onended = null;
      current.stop();
    } catch {
      // already stopped / ended
    }
    current = null;
  }
}

/** Decode + play an audio blob through the unlocked context. Resolves true if
 *  playback started, false if Web Audio is unavailable. `onEnded` fires when
 *  the clip finishes (not when interrupted via `stopAudio`). Throws if decode
 *  or start fails — caller handles fallback. */
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
    if (current === src) current = null;
    onEnded();
  };
  current = src;
  src.start();
  return true;
}
