/**
 * Voice-selection store — the reply-voice (TTS timbre) choice, shared by the
 * settings panel and the voice screen's quick switcher.
 *
 * Server-backed and per-tenant: `loadVoices` hydrates from `GET /api/voices`,
 * `selectVoice` updates optimistically and persists via `PUT /api/my/voice`,
 * reverting on failure. Follows the repo's hand-rolled `useSyncExternalStore`
 * store idiom (see `file-store.ts`).
 */
import { useSyncExternalStore } from "react";
import { getVoices, setVoice, type VoiceInfo } from "@/api/voice";

export type VoiceStatus = "idle" | "loading" | "ready" | "error";

export interface VoiceState {
  voices: VoiceInfo[];
  current: string;
  status: VoiceStatus;
}

const initial: VoiceState = { voices: [], current: "", status: "idle" };

let state: VoiceState = initial;
// Snapshot is reference-stable between updates so useSyncExternalStore can
// detect changes by identity.
let snapshot: VoiceState = state;
const listeners = new Set<() => void>();

function setState(patch: Partial<VoiceState>) {
  state = { ...state, ...patch };
  snapshot = state;
  listeners.forEach((fn) => fn());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): VoiceState {
  return snapshot;
}

/** Current store snapshot (non-hook reads, e.g. tests). */
export function getVoiceState(): VoiceState {
  return snapshot;
}

/** Hydrate the voice list + current choice from the server. */
export async function loadVoices(): Promise<void> {
  setState({ status: "loading" });
  try {
    const res = await getVoices();
    setState({ voices: res.voices, current: res.current, status: "ready" });
  } catch {
    setState({ status: "error" });
  }
}

/**
 * Switch the reply voice: optimistic update, then persist. On success adopt the
 * server's canonical id (an alias resolves to its real voice); on failure
 * revert and rethrow so the caller can surface a toast.
 */
export async function selectVoice(id: string): Promise<void> {
  const prev = state.current;
  if (id === prev) return;
  setState({ current: id }); // optimistic
  try {
    const res = await setVoice(id);
    if (res.voice && res.voice !== state.current) {
      setState({ current: res.voice });
    }
  } catch (e) {
    setState({ current: prev }); // revert
    throw e;
  }
}

/** Subscribe to the voice store from a component. */
export function useVoiceStore(): VoiceState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: reset module state between cases. */
export function __resetVoiceStoreForTests(): void {
  state = initial;
  snapshot = state;
  listeners.clear();
}
