import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft, FolderOpen, Globe, MessageSquare, Moon, Sun } from "lucide-react";
import { Link } from "react-router-dom";

import type { ContentEntry } from "@/api/content";
import { ContentViewerOverlay, type ViewerState } from "@/components/content-viewer";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useTheme } from "@/hooks/use-theme";

import { useSites } from "../context/sites-context";
import { ProjectFiles } from "../components/project-files";
import { SitesTaskStatusIndicator } from "../components/sites-task-status-indicator";

export function SitesEditorLayout({
  previewPanel,
  chatPanel,
}: {
  previewPanel: React.ReactNode;
  chatPanel?: React.ReactNode;
}) {
  const [showChat, setShowChat] = useState(true);
  const [showFiles, setShowFiles] = useState(true);
  const { project, save } = useSites();
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
    storageKey: "octos_sites_chat_width",
  });
  const {
    effectiveWidth: filesWidth,
    onMouseDown: onFilesResizeStart,
  } = useResizablePanel({
    side: "right",
    minWidth: 260,
    maxWidth: 640,
    defaultWidth: 320,
    storageKey: "octos_sites_files_width",
  });
  const [viewerState, setViewerState] = useState<ViewerState>({
    type: null,
    entry: null,
    allEntries: [],
  });

  const closeViewer = useCallback(() => {
    setViewerState({ type: null, entry: null, allEntries: [] });
  }, []);

  const openProjectFile = useCallback((entry: ContentEntry, allEntries: ContentEntry[]) => {
    const textLike =
      entry.category === "report" ||
      /\.(md|markdown|txt|js|jsx|ts|tsx|json|css|html|astro|qmd|yaml|yml|sh|mjs|cjs)$/i.test(
        entry.filename,
      );
    setViewerState({
      type: entry.category === "image" ? "image" : textLike ? "markdown" : null,
      entry,
      allEntries: entry.category === "image" ? allEntries : [],
    });
  }, []);

  const filesPanel = useMemo(() => {
    if (!showFiles) return null;
    if (project?.scaffoldError) {
      return (
        <div className="flex h-full flex-col justify-center px-4 text-center">
          <div className="text-sm font-medium text-text">Site scaffold failed</div>
          <div className="mt-2 text-xs leading-6 text-muted">{project.scaffoldError}</div>
        </div>
      );
    }
    if (!project?.slug || !project.scaffolded) {
      return (
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
          Project files appear after the site session has been scaffolded.
        </div>
      );
    }
    return (
      <ProjectFiles
        slug={project.slug}
        title={project.title}
        sessionId={project.id}
        profileId={project.profileId}
        template={project.template}
        onOpenFile={openProjectFile}
        onRename={(nextTitle) => save({ title: nextTitle })}
      />
    );
  }, [
    openProjectFile,
    project?.id,
    project?.scaffoldError,
    project?.scaffolded,
    project?.slug,
    project?.profileId,
    project?.title,
    save,
    showFiles,
  ]);

  const projectStatus = project?.scaffoldError
    ? { label: "Error", className: "bg-red-500/10 text-red-300" }
    : !project?.scaffolded
      ? { label: "Scaffolding", className: "bg-amber-500/10 text-amber-300" }
      : project?.previewUrl
        ? { label: "HTTPS Preview", className: "bg-emerald-500/10 text-emerald-300" }
        : { label: "Ready", className: "bg-surface-container text-muted" };

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-3">
          <Link
            to="/sites"
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted transition hover:bg-surface-container hover:text-white"
          >
            <ArrowLeft size={16} />
            Back
          </Link>
          <div className="h-5 w-px bg-border" />
          <Globe size={16} className="text-accent" />
          {editingTitle ? (
            <input
              ref={titleInputRef}
              defaultValue={project?.title || ""}
              className="max-w-sm rounded border border-accent/50 bg-surface-container px-2 py-0.5 text-sm font-medium text-text outline-none"
              autoFocus
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next && next !== project?.title) save({ title: next });
                setEditingTitle(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditingTitle(false);
              }}
            />
          ) : (
            <span
              className="max-w-sm cursor-pointer truncate text-sm font-medium text-text transition hover:text-accent"
              onClick={() => setEditingTitle(true)}
              title="Click to rename"
            >
              {project?.title || "Untitled Site"}
            </span>
          )}
          {project && (
            <span className="rounded-full bg-surface-container px-2 py-0.5 text-xs text-muted">
              {project.template}
            </span>
          )}
          {project && (
            <span className={`rounded-full px-2 py-0.5 text-xs ${projectStatus.className}`}>
              {projectStatus.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {project?.id && (
            <SitesTaskStatusIndicator
              sessionId={project.id}
              historyTopic={project.preset ? `site ${project.preset}` : undefined}
              profileId={project.profileId}
            />
          )}
          <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="rounded-lg p-2 text-muted transition hover:text-text"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={() => setShowChat((value) => !value)}
            className={`rounded-lg p-2 transition ${
              showChat ? "bg-surface-container text-accent" : "text-muted hover:text-text"
            }`}
            title="Toggle chat"
          >
            <MessageSquare size={16} />
          </button>
          <button
            onClick={() => setShowFiles((value) => !value)}
            className={`rounded-lg p-2 transition ${
              showFiles ? "bg-surface-container text-accent" : "text-muted hover:text-text"
            }`}
            title="Toggle files"
          >
            <FolderOpen size={16} />
          </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showChat && (
          <>
            <div
              style={{ width: chatWidth }}
              className="shrink-0 overflow-hidden border-r border-border bg-surface"
            >
              {chatPanel}
            </div>
            <div
              onMouseDown={onChatResizeStart}
              className="panel-resize-handle"
              title="Resize chat panel"
            />
          </>
        )}

        <div className="min-w-0 flex-1 bg-surface-dark">{previewPanel}</div>

        {showFiles && (
          <>
            <div
              onMouseDown={onFilesResizeStart}
              className="panel-resize-handle"
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
