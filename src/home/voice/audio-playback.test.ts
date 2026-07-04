/**
 * audio-playback unit tests.
 *
 * The load-bearing contract: `playAudioBlob(blob, onEnded)`'s `onEnded`
 * callback fires EXACTLY ONCE for every started clip — on natural end,
 * on interrupt via `stopAudio()`, and on supersede by a newer clip.
 * `use-voice-conversation.ts`'s `playOne` resolves its await inside that
 * callback; if an interrupt orphans it, the reply drain loop's
 * `playingRef` stays latched true and every later reply is silenced
 * until the user leaves /voice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { playAudioBlob, stopAudio } from "./audio-playback";

class FakeSource {
  buffer: unknown = null;
  onended: ((ev: Event) => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

const sources: FakeSource[] = [];

class FakeAudioContext {
  state = "running";
  destination = {};
  resume = vi.fn(async () => {});
  decodeAudioData = vi.fn(async () => ({}) as AudioBuffer);
  createBufferSource() {
    const s = new FakeSource();
    sources.push(s);
    return s;
  }
}

// NB: audio-playback caches its module-level AudioContext on first use, so
// the stub must be in place before the first `playAudioBlob` call and the
// same fake instance is shared by every test in this file (it is stateless;
// per-clip state lives on the FakeSource entries in `sources`).
vi.stubGlobal("AudioContext", FakeAudioContext);

function makeBlob(): Blob {
  const blob = new Blob(["x"]);
  if (typeof blob.arrayBuffer !== "function") {
    // Older jsdom Blobs lack arrayBuffer(); provide the minimal surface.
    (blob as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
      async () => new ArrayBuffer(1);
  }
  return blob;
}

beforeEach(() => {
  // Drain any clip a previous test left playing, THEN forget its source.
  stopAudio();
  sources.length = 0;
});

describe("playAudioBlob / stopAudio", () => {
  it("fires onEnded when the clip ends naturally, and a later stopAudio does not re-fire it", async () => {
    const onEnded = vi.fn();
    await expect(playAudioBlob(makeBlob(), onEnded)).resolves.toBe(true);
    expect(sources).toHaveLength(1);
    expect(onEnded).not.toHaveBeenCalled();

    // Browser fires `ended` when playback finishes.
    sources[0].onended?.(new Event("ended"));
    expect(onEnded).toHaveBeenCalledTimes(1);

    stopAudio();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("stopAudio (interrupt) fires the in-flight clip's onEnded so awaiting callers resolve", async () => {
    // THE bug: an interrupt mid-playback nulled `onended` before stop(), so
    // `playOne`'s promise never resolved and the voice drain loop wedged —
    // no subsequent reply audio ever played.
    const onEnded = vi.fn();
    await playAudioBlob(makeBlob(), onEnded);

    stopAudio();
    expect(sources[0].stop).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire onEnded when the browser's late `ended` event lands after an interrupt", async () => {
    const onEnded = vi.fn();
    await playAudioBlob(makeBlob(), onEnded);

    stopAudio();
    expect(onEnded).toHaveBeenCalledTimes(1);

    // Per spec, stop() makes the source fire `ended` asynchronously — the
    // handler must have been detached so the interrupt's own invocation
    // stays the only one.
    sources[0].onended?.(new Event("ended"));
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("starting a new clip supersedes the previous one and fires its onEnded exactly once", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await playAudioBlob(makeBlob(), first);
    await playAudioBlob(makeBlob(), second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    // The second clip still completes normally.
    sources[1].onended?.(new Event("ended"));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stopAudio is a no-op when nothing is playing", () => {
    expect(() => stopAudio()).not.toThrow();
  });
});
