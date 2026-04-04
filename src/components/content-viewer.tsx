import { useState, useCallback } from "react";
import type { ContentEntry } from "@/api/content";
import { downloadContent } from "@/api/content";
import { ImageAlbumViewer } from "@/components/viewers/image-album-viewer";
import { MarkdownViewer } from "@/components/viewers/markdown-viewer";
import { AudioPlayer } from "@/components/viewers/audio-player";
import { VideoPlayer } from "@/components/viewers/video-player";

interface ViewerState {
  type: "image" | "markdown" | "audio" | "video" | null;
  entry: ContentEntry | null;
  allEntries: ContentEntry[];
}

/** Hook to manage content viewer state. */
export function useContentViewer() {
  const [state, setState] = useState<ViewerState>({
    type: null,
    entry: null,
    allEntries: [],
  });

  const openViewer = useCallback(
    (entry: ContentEntry, allEntries: ContentEntry[]) => {
      switch (entry.category) {
        case "image": {
          const images = allEntries.filter((e) => e.category === "image");
          setState({ type: "image", entry, allEntries: images });
          break;
        }
        case "report":
          if (
            entry.filename.endsWith(".md") ||
            entry.filename.endsWith(".txt")
          ) {
            setState({ type: "markdown", entry, allEntries: [] });
          } else {
            downloadContent(entry);
          }
          break;
        case "audio":
          setState({ type: "audio", entry, allEntries: [] });
          break;
        case "video":
          setState({ type: "video", entry, allEntries: [] });
          break;
        default:
          downloadContent(entry);
          break;
      }
    },
    [],
  );

  const closeViewer = useCallback(() => {
    setState({ type: null, entry: null, allEntries: [] });
  }, []);

  const closeAudio = useCallback(() => {
    if (state.type === "audio") {
      setState({ type: null, entry: null, allEntries: [] });
    }
  }, [state.type]);

  return { state, openViewer, closeViewer, closeAudio };
}

/** Renders the active viewer overlay/modal. */
export function ContentViewerOverlay({
  state,
  onClose,
  onCloseAudio,
}: {
  state: ViewerState;
  onClose: () => void;
  onCloseAudio: () => void;
}) {
  if (!state.entry) return null;

  switch (state.type) {
    case "image": {
      const idx = state.allEntries.findIndex((e) => e.id === state.entry!.id);
      return (
        <ImageAlbumViewer
          entries={state.allEntries}
          initialIndex={Math.max(0, idx)}
          onClose={onClose}
        />
      );
    }
    case "markdown":
      return <MarkdownViewer entry={state.entry} onClose={onClose} />;
    case "video":
      return <VideoPlayer entry={state.entry} onClose={onClose} />;
    case "audio":
      return <AudioPlayer entry={state.entry} onClose={onCloseAudio} />;
    default:
      return null;
  }
}
