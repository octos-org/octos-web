let pendingWakeAudio: Blob | null = null;

/** One-shot, in-memory handoff. Wake audio must not survive a refresh. */
export function storeWakeAudio(audio: Blob): void {
  pendingWakeAudio = audio;
}
export function consumeWakeAudio(): Blob | null {
  const audio = pendingWakeAudio;
  pendingWakeAudio = null;
  return audio;
}

export function clearWakeAudio(): void {
  pendingWakeAudio = null;
}
