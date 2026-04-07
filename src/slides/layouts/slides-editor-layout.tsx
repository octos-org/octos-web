import { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FolderOpen,
  MessageSquare,
  Moon,
  Presentation,
  Sun,
} from "lucide-react";
import { Link } from "react-router-dom";

import type { ContentEntry } from "@/api/content";
import {
  ContentViewerOverlay,
  type ViewerState,
} from "@/components/content-viewer";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useSlides } from "../context/slides-context";
import { ProjectFiles } from "../components/project-files";
import { useTheme } from "@/hooks/use-theme";

export function SlidesEditorLayout({
  previewPanel,
  chatPanel,
}: {
  previewPanel: React.ReactNode;
  chatPanel?: React.ReactNode;
}) {
  const [showChat, setShowChat] = useState(true);
  const [showFiles, setShowFiles] = useState(true);
  const { project, save } = useSlides();
  const { theme, toggleTheme } = useTheme();
  const [editingTitle, setEditingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const {
    effectiveWidth: chatWidth,
    onMouseDown: onChatResizeStart,
  } = useResizablePanel({
    side: "left",
    minWidth: 320,
    maxWidth: 720,
    defaultWidth: 384,
    storageKey: "octos_slides_chat_width",
  });
  const {
    effectiveWidth: filesWidth,
    onMouseDown: onFilesResizeStart,
  } = useResizablePanel({
    side: "right",
    minWidth: 240,
    maxWidth: 560,
    defaultWidth: 256,
    storageKey: "octos_slides_files_width",
  });
  const [viewerState, setViewerState] = useState<ViewerState>({
    type: null,
    entry: null,
    allEntries: [],
  });

  const closeViewer = useCallback(() => {
    setViewerState({ type: null, entry: null, allEntries: [] });
  }, []);

  const openProjectFile = useCallback(
    (entry: ContentEntry, allEntries: ContentEntry[]) => {
      const markdownLike = /\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(
        entry.filename,
      );
      setViewerState({
        type: entry.category === "image" ? "image" : markdownLike ? "markdown" : null,
        entry,
        allEntries: entry.category === "image" ? allEntries : [],
      });
    },
    [],
  );

  const filesPanel = useMemo(() => {
    if (!showFiles) return null;
    if (!project?.slug) {
      return (
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
          Project files appear after the slides session has been scaffolded.
        </div>
      );
    }
    return (
      <ProjectFiles
        slug={project.slug}
        title={project.title}
        sessionId={project.chatSessionId}
        onOpenFile={openProjectFile}
        onRename={(t) => save({ title: t })}
      />
    );
  }, [openProjectFile, project?.chatSessionId, project?.slug, showFiles]);

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
        <div className="flex items-center gap-3">
          <Link
            to="/slides"
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-muted hover:text-white hover:bg-surface-container transition text-sm"
          >
            <ArrowLeft size={16} />
            Back
          </Link>
          <div className="w-px h-5 bg-border" />
          <Presentation size={16} className="text-accent" />
          {editingTitle ? (
            <input
              ref={titleInputRef}
              defaultValue={project?.title || ""}
              className="text-sm font-medium text-text bg-surface-container rounded px-2 py-0.5 outline-none border border-accent/50 max-w-sm"
              autoFocus
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== project?.title) save({ title: v });
                setEditingTitle(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditingTitle(false);
              }}
            />
          ) : (
            <span
              className="text-sm font-medium text-text truncate max-w-sm cursor-pointer hover:text-accent transition"
              onClick={() => setEditingTitle(true)}
              title="Click to rename"
            >
              {project?.title || "Untitled Deck"}
            </span>
          )}
          {project && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface-container text-muted">
              {project.slides.length} slides
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="rounded-lg p-2 text-muted hover:text-text transition"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={() => setShowChat(!showChat)}
            className={`rounded-lg p-2 transition ${
              showChat
                ? "bg-surface-container text-accent"
                : "text-muted hover:text-text"
            }`}
            title="Toggle chat"
          >
            <MessageSquare size={16} />
          </button>
          <button
            onClick={() => setShowFiles((value) => !value)}
            className={`rounded-lg p-2 transition ${
              showFiles
                ? "bg-surface-container text-accent"
                : "text-muted hover:text-text"
            }`}
            title="Toggle files"
          >
            <FolderOpen size={16} />
          </button>
        </div>
      </div>

      {/* Layout: chat (left) + preview (center) + files (right) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Chat */}
        {showChat && (
          <>
            <div
              style={{ width: chatWidth }}
              className="shrink-0 overflow-hidden border-r border-border bg-surface"
            >
              {chatPanel || (
                <div className="flex h-full items-center justify-center text-xs text-muted/50">
                  Chat with the slides agent
                </div>
              )}
            </div>
            <div
              onMouseDown={onChatResizeStart}
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30 transition-colors"
              title="Resize chat panel"
            />
          </>
        )}

        {/* Right: Preview */}
        <div className="flex-1 min-w-0 bg-surface-dark">{previewPanel}</div>

        {showFiles && (
          <>
            <div
              onMouseDown={onFilesResizeStart}
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30 transition-colors"
              title="Resize files panel"
            />
            <div
              style={{ width: filesWidth }}
              className="shrink-0 overflow-hidden border-l border-border bg-surface"
            >
              {filesPanel}
            </div>
          </>
        )}
      </div>

      <ContentViewerOverlay
        state={viewerState}
        onClose={closeViewer}
        onCloseAudio={closeViewer}
      />
    </div>
  );
}
