import { useState, useCallback } from "react";
import type { ContentEntry } from "@/api/content";
import { downloadContent } from "@/api/content";
import { ImageAlbumViewer } from "@/components/viewers/image-album-viewer";
import { VideoPlayer } from "@/components/viewers/video-player";
import { MarkdownViewer } from "@/components/viewers/markdown-viewer";

export interface ViewerState {
  type: "image" | "audio" | "video" | "markdown" | null;
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
        case "audio":
          // Audio plays inside the content browser panel
          setState({ type: "audio", entry, allEntries: [] });
          break;
        case "video":
          setState({ type: "video", entry, allEntries: [] });
          break;
        case "report":
          // Markdown/text reports — open in viewer
          if (/\.(md|txt|markdown)$/i.test(entry.filename)) {
            setState({ type: "markdown", entry, allEntries: [] });
          } else {
            downloadContent(entry);
          }
          break;
        default:
          // Check filename for markdown
          if (/\.(md|txt|markdown)$/i.test(entry.filename)) {
            setState({ type: "markdown", entry, allEntries: [] });
          } else {
            downloadContent(entry);
          }
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

/** Renders overlay viewers (image album, video). Audio is handled inside ContentBrowser. */
export function ContentViewerOverlay({
  state,
  onClose,
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
    case "video":
      return <VideoPlayer entry={state.entry} onClose={onClose} />;
    case "markdown":
      return <MarkdownViewer entry={state.entry} onClose={onClose} />;
    default:
      return null;
  }
}
