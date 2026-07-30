const OLL_PLAYBACK_STORAGE_VERSION = "v4";

export function ollPlaybackStorageKey(
  sessionId: string,
  fixture: "geometry-v2" | undefined,
): string {
  return `octos-learning-oll:${OLL_PLAYBACK_STORAGE_VERSION}:${sessionId}:${fixture ?? "none"}`;
}
