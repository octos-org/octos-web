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
    if (!project?.slug || !project.scaffolded) {
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
        sessionId={project.id}
        historyTopic={`slides ${project.slug}`}
        onOpenFile={openProjectFile}
        onRename={(t) => save({ title: t })}
      />
    );
  }, [openProjectFile, project?.id, project?.scaffolded, project?.slug, project?.title, save, showFiles]);

  return (
    <div className="chat-shell flex h-screen flex-col gap-3 p-3">
      {/* Header */}
      <div className="glass-panel rounded-[16px] p-3">
        <div className="glass-toolbar flex items-center justify-between gap-4 rounded-[14px] px-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              to="/slides"
              className="glass-icon-button flex items-center gap-1.5 rounded-[10px] px-3 py-2 text-sm"
            >
              <ArrowLeft size={16} />
              Back
            </Link>
            <div className="glass-pill h-9 w-px self-stretch rounded-full px-0 py-0" />
            <div className="glass-pill flex h-10 w-10 items-center justify-center rounded-[10px] text-accent">
              <Presentation size={16} />
            </div>
            <div className="min-w-0">
              <div className="shell-kicker">Slides Workspace</div>
              {editingTitle ? (
                <input
                  ref={titleInputRef}
                  defaultValue={project?.title || ""}
                  className="mt-1 max-w-sm rounded-[12px] border border-accent/50 bg-surface-container px-3 py-2 text-lg font-semibold tracking-tight text-text outline-none"
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
                  className="block max-w-sm truncate text-lg font-semibold tracking-tight text-text-strong transition hover:text-accent"
                  onClick={() => setEditingTitle(true)}
                  title="Click to rename"
                >
                  {project?.title || "Untitled Deck"}
                </span>
              )}
            </div>
            {project && (
              <span className="glass-pill rounded-[12px] px-3 py-1.5 text-xs text-muted">
                {project.slides.length} slides
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="glass-icon-button rounded-[10px] p-2.5"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              onClick={() => setShowChat(!showChat)}
              className={`glass-icon-button rounded-[10px] p-2.5 ${
                showChat ? "is-active" : ""
              }`}
              title="Toggle chat"
            >
              <MessageSquare size={16} />
            </button>
            <button
              onClick={() => setShowFiles((value) => !value)}
              className={`glass-icon-button rounded-[10px] p-2.5 ${
                showFiles ? "is-active" : ""
              }`}
              title="Toggle files"
            >
              <FolderOpen size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Layout: chat (left) + preview (center) + files (right) */}
      <div className="flex flex-1 min-h-0 overflow-hidden gap-3">
        {/* Left: Chat */}
        {showChat && (
          <>
            <div
              style={{ width: chatWidth }}
              className="glass-panel shrink-0 overflow-hidden rounded-[16px]"
            >
              {chatPanel || (
                <div className="flex h-full items-center justify-center text-xs text-muted/50">
                  Chat with the slides agent
                </div>
              )}
            </div>
            <div
              onMouseDown={onChatResizeStart}
              className="panel-resize-handle"
              title="Resize chat panel"
            />
          </>
        )}

        {/* Right: Preview */}
        <div className="glass-panel flex-1 min-w-0 overflow-hidden rounded-[16px]">
          {previewPanel}
        </div>

        {showFiles && (
          <>
            <div
              onMouseDown={onFilesResizeStart}
              className="panel-resize-handle"
              title="Resize files panel"
            />
            <div
              style={{ width: filesWidth }}
              className="shrink-0 overflow-hidden"
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
