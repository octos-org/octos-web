import { useCallback, useRef, useState } from "react";
import { FolderOpen, Globe, MessageSquare } from "lucide-react";

import type { ContentEntry } from "@/api/content";
import { ContentViewerOverlay, type ViewerState } from "@/components/content-viewer";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import {
  WorkbenchStatusPill,
  WorkbenchThemeButton,
} from "@/components/workbench-shell";
import { StudioTopbar } from "@/components/studio-topbar";

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

  let filesPanel: React.ReactNode = null;
  if (showFiles) {
    if (project?.scaffoldError) {
      filesPanel = (
        <div className="flex h-full flex-col justify-center px-4 text-center">
          <div className="text-sm font-medium text-text">Site scaffold failed</div>
          <div className="mt-2 text-xs leading-6 text-muted">{project.scaffoldError}</div>
        </div>
      );
    } else if (!project?.slug || !project.scaffolded) {
      filesPanel = (
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
          Project files appear after the site session has been scaffolded.
        </div>
      );
    } else {
      filesPanel = (
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
    }
  }

  const projectStatus = project?.scaffoldError
    ? { label: "Error", tone: "danger" as const }
    : !project?.scaffolded
      ? { label: "Scaffolding", tone: "warning" as const }
      : project?.previewUrl
        ? { label: "HTTPS Preview", tone: "success" as const }
        : { label: "Ready", tone: "default" as const };

  return (
    <div className="studio-shell flex h-screen flex-col">
      <StudioTopbar
        backTo="/sites"
        icon={Globe}
        context="Site Workspace"
        title={
          editingTitle ? (
            <input
              ref={titleInputRef}
              defaultValue={project?.title || ""}
              className="workbench-input max-w-sm px-2 py-1 text-sm font-medium"
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
            <button
              type="button"
              className="max-w-sm truncate text-left transition hover:text-accent"
              onClick={() => setEditingTitle(true)}
              title="Click to rename"
            >
              {project?.title || "Untitled Site"}
            </button>
          )
        }
        badge={
          project ? (
            <>
              <WorkbenchStatusPill>{project.template}</WorkbenchStatusPill>
              <WorkbenchStatusPill tone={projectStatus.tone}>
                {projectStatus.label}
              </WorkbenchStatusPill>
            </>
          ) : undefined
        }
        actions={
          <>
            {project?.id && (
              <SitesTaskStatusIndicator
                sessionId={project.id}
                historyTopic={project.preset ? `site ${project.preset}` : undefined}
                profileId={project.profileId}
              />
            )}
            <WorkbenchThemeButton />
            <button
              onClick={() => setShowChat((value) => !value)}
              className={`glass-icon-button p-2 ${
                showChat ? "is-active" : ""
              }`}
              title="Toggle chat"
            >
              <MessageSquare size={16} />
            </button>
            <button
              onClick={() => setShowFiles((value) => !value)}
              className={`glass-icon-button p-2 ${
                showFiles ? "is-active" : ""
              }`}
              title="Toggle files"
            >
              <FolderOpen size={16} />
            </button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2 max-lg:flex-col max-lg:overflow-y-auto">
        {showChat && (
          <>
            <div
              style={{ width: chatWidth }}
              className="glass-panel shrink-0 overflow-hidden rounded-lg max-lg:!h-72 max-lg:!w-full"
            >
              {chatPanel}
            </div>
            <div
              onMouseDown={onChatResizeStart}
              className="panel-resize-handle max-lg:hidden"
              title="Resize chat panel"
            />
          </>
        )}

        <div className="glass-panel min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg max-lg:min-h-[28rem]">
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
              className="glass-panel shrink-0 overflow-hidden rounded-lg max-lg:!h-80 max-lg:!w-full"
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
