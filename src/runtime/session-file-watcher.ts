import * as FileStore from "@/store/file-store";
import * as ProjectionStore from "@/store/projection-store";

/** Refresh generated files when the mounted conversation finishes work. */
export function watchSessionFiles(sessionId: string, topic?: string): () => void {
  const scope = ProjectionStore.projectionStoreKey(sessionId, topic);
  let refresh: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = ProjectionStore.onEnvelopeAdmitted((key, envelope) => {
    if (key !== scope || envelope.payload.type !== "turn_terminal") return;
    // A hydrate can admit many historical terminals in the same batch.
    if (refresh !== undefined) return;
    refresh = setTimeout(() => {
      refresh = undefined;
      void FileStore.loadSessionFiles(sessionId);
    }, 0);
  });
  void FileStore.loadSessionFiles(sessionId);
  return () => {
    unsubscribe();
    clearTimeout(refresh);
  };
}
