/**
 * Durable-in-memory receive store for voice ASR progress.
 *
 * `progress/updated(kind=voice_transcript)` can arrive several seconds before
 * the first canonical user/assistant envelope. A one-shot DOM event is not a
 * render source: consumers that subscribe after the dispatch permanently miss
 * it. This store records the latest transcript at the WebSocket boundary and
 * exposes a stable snapshot through `useSyncExternalStore`.
 */

export interface VoiceTranscriptSnapshot {
  transcripts: ReadonlyMap<string, string>;
  turnIds: readonly string[];
}

interface MutableVoiceTranscriptState {
  transcripts: Map<string, string>;
  turnIds: string[];
  snapshot: VoiceTranscriptSnapshot;
}

const EMPTY_SNAPSHOT: VoiceTranscriptSnapshot = {
  transcripts: new Map(),
  turnIds: [],
};
const states = new Map<string, MutableVoiceTranscriptState>();
const listeners = new Set<() => void>();

function storeKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return `${sessionId}\u0000${trimmedTopic ?? ""}`;
}

function publish(state: MutableVoiceTranscriptState): void {
  state.snapshot = {
    transcripts: new Map(state.transcripts),
    turnIds: state.turnIds.slice(),
  };
  for (const listener of [...listeners]) listener();
}

export function upsert(
  sessionId: string,
  topic: string | undefined,
  turnId: string,
  transcript: string,
): void {
  const text = transcript.trim();
  if (!sessionId || !turnId || !text) return;
  const key = storeKey(sessionId, topic);
  let state = states.get(key);
  if (!state) {
    state = {
      transcripts: new Map(),
      turnIds: [],
      snapshot: EMPTY_SNAPSHOT,
    };
    states.set(key, state);
  }
  if (state.transcripts.get(turnId) === text) return;
  if (!state.transcripts.has(turnId)) state.turnIds.push(turnId);
  state.transcripts.set(turnId, text);
  publish(state);
}

export function remove(
  sessionId: string,
  topic: string | undefined,
  turnId: string,
): void {
  const state = states.get(storeKey(sessionId, topic));
  if (!state?.transcripts.has(turnId)) return;
  state.transcripts.delete(turnId);
  state.turnIds = state.turnIds.filter((id) => id !== turnId);
  publish(state);
}

export function clearScope(sessionId: string, topic?: string): void {
  const key = storeKey(sessionId, topic);
  if (!states.delete(key)) return;
  for (const listener of [...listeners]) listener();
}

export function getSnapshot(
  sessionId: string,
  topic?: string,
): VoiceTranscriptSnapshot {
  return states.get(storeKey(sessionId, topic))?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function __resetVoiceTranscriptStoreForTests(): void {
  states.clear();
  listeners.clear();
}
