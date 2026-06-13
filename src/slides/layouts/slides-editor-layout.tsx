import { useCallback, useRef, useState } from "react";
import {
  FolderOpen,
  MessageSquare,
  Presentation,
} from "lucide-react";

import type { ContentEntry } from "@/api/content";
import {
  ContentViewerOverlay,
  type ViewerState,
} from "@/components/content-viewer";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useSlides } from "../context/slides-context";
import { ProjectFiles } from "../components/project-files";
import {
  WorkbenchStatusPill,
  WorkbenchThemeButton,
  WorkbenchTopbar,
} from "@/components/workbench-shell";

export function SlidesEditorLayout({
  previewPanel,
  chatPanel,
  onRetryScaffold,
}: {
  previewPanel: React.ReactNode;
  chatPanel?: React.ReactNode;
  /** Codex round-3 BLOCK D.b: fired by the files-panel retry button
   *  when a scaffold attempt has failed. The page owner clears
   *  `project.scaffoldError` and bumps the SlidesChat retryNonce so
   *  the auto-scaffold effect re-fires. */
  onRetryScaffold?: () => void;
}) {
  const [showChat, setShowChat] = useState(true);
  const [showFiles, setShowFiles] = useState(true);
  const { project, save } = useSlides();
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

  let filesPanel: React.ReactNode = null;
  if (showFiles) {
    // Codex round-3 BLOCK D.b: render scaffoldError + retry button
    // (Sites-symmetric) when the scaffold attempt failed. Pre-fix
    // the user saw only the generic "appear after scaffolded"
    // placeholder, with no way to tell the attempt had actually
    // failed and no way to retry.
    if (project?.scaffoldError) {
      filesPanel = (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
          <div className="text-sm font-medium text-text">
            Slides scaffold failed
          </div>
          <div className="text-xs leading-6 text-muted">
            {project.scaffoldError}
          </div>
          {onRetryScaffold && (
            <button
              type="button"
              onClick={onRetryScaffold}
              className="glass-pill rounded-[10px] px-3 py-1.5 text-xs text-accent transition hover:text-text"
            >
              Retry scaffold
            </button>
          )}
        </div>
      );
    } else if (!project?.slug || !project.scaffolded) {
      filesPanel = (
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
          Project files appear after the slides session has been scaffolded.
        </div>
      );
    } else {
      filesPanel = (
        <ProjectFiles
          slug={project.slug}
          title={project.title}
          sessionId={project.id}
          historyTopic={`slides ${project.slug}`}
          onOpenFile={openProjectFile}
          onRename={(t) => save({ title: t })}
        />
      );
    }
  }

  return (
    <div className="workbench-shell flex h-screen flex-col gap-2 p-2">
      <WorkbenchTopbar
        backTo="/slides"
        icon={Presentation}
        context="Slides Workspace"
        title={
          editingTitle ? (
            <input
              ref={titleInputRef}
              defaultValue={project?.title || ""}
              className="workbench-input max-w-sm px-3 py-2 text-lg font-semibold tracking-tight"
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
            <button
              type="button"
              className="block max-w-sm truncate text-left transition hover:text-accent"
              onClick={() => setEditingTitle(true)}
              title="Click to rename"
            >
              {project?.title || "Untitled Deck"}
            </button>
          )
        }
        badge={
          project ? (
            <WorkbenchStatusPill>
              {project.slides.length} slides
            </WorkbenchStatusPill>
          ) : undefined
        }
        actions={
          <>
            <WorkbenchThemeButton />
            <button
              onClick={() => setShowChat(!showChat)}
              className={`glass-icon-button p-2.5 ${
                showChat ? "is-active" : ""
              }`}
              title="Toggle chat"
            >
              <MessageSquare size={16} />
            </button>
            <button
              onClick={() => setShowFiles((value) => !value)}
              className={`glass-icon-button p-2.5 ${
                showFiles ? "is-active" : ""
              }`}
              title="Toggle files"
            >
              <FolderOpen size={16} />
            </button>
          </>
        }
      />

      {/* Layout: chat (left) + preview (center) + files (right) */}
      <div className="flex flex-1 min-h-0 gap-2 overflow-hidden max-lg:flex-col max-lg:overflow-y-auto">
        {/* Left: Chat */}
        {showChat && (
          <>
            <div
              style={{ width: chatWidth }}
              className="glass-panel shrink-0 overflow-hidden rounded-lg max-lg:!h-72 max-lg:!w-full"
            >
              {chatPanel || (
                <div className="flex h-full items-center justify-center text-xs text-muted/50">
                  Chat with the slides agent
                </div>
              )}
            </div>
            <div
              onMouseDown={onChatResizeStart}
              className="panel-resize-handle max-lg:hidden"
              title="Resize chat panel"
            />
          </>
        )}

        {/* Right: Preview */}
        <div className="glass-panel min-h-0 flex-1 min-w-0 overflow-hidden rounded-lg max-lg:min-h-[28rem]">
          {previewPanel}
        </div>

        {showFiles && (
          <>
            <div
              onMouseDown={onFilesResizeStart}
              className="panel-resize-handle max-lg:hidden"
              title="Resize files panel"
            />
            <div
              style={{ width: filesWidth }}
              className="shrink-0 overflow-hidden max-lg:!h-80 max-lg:!w-full"
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
