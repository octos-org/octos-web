import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { PanelLeft, PanelRight } from "lucide-react";

import { ChatThread } from "@/components/chat-thread";
import { StudioNav } from "@/components/studio-nav";
import { UiProtocolApprovalHost } from "@/components/ui-protocol-approval-host";
import { UiProtocolQuestionHost } from "@/components/ui-protocol-question-host";
import { ScopedRuntimeBridge } from "@/runtime/runtime-provider";
import {
  SessionContext,
  useModeState,
  type SessionBeforeSendResult,
  type SessionContextValue,
  type SessionSendRequest,
} from "@/runtime/session-context";
import { recordProjectOpened } from "@/store/project-store";
import { useResizablePanel } from "@/hooks/use-resizable-panel";

import { mergeSourceMedia } from "./source-media";
import { StudioRail } from "./studio-rail";
import { StudioSourcesPane } from "./studio-sources-pane";
import type { CitationTarget } from "./structured-asset-viewers";
import { withNotebookToolContext } from "./tool-context";
import { useNotebookSources } from "./use-notebook-sources";

const TITLE_STORAGE_KEY = "octos_session_titles";
const PANES_STORAGE_KEY = "octos-studio-panes";

interface PaneState {
  sources: boolean;
  rail: boolean;
}

function readStoredTitle(sessionId: string): string {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TITLE_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown> | null;
    const title = parsed?.[sessionId];
    if (typeof title === "string" && title.trim()) return title;
  } catch {
    // fall through to the default
  }
  return "Studio Project";
}

/**
 * Register this session in the shared titles record. SessionProvider is
 * the usual writer, but it only mounts on /chat — without this, projects
 * created and used purely through /studio would never show up in the
 * Home launcher's project feed (which reads the same record).
 */
function persistStoredTitle(sessionId: string, title: string): void {
  try {
    const raw = localStorage.getItem(TITLE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const titles =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    if (titles[sessionId] === title) return;
    localStorage.setItem(
      TITLE_STORAGE_KEY,
      JSON.stringify({ ...titles, [sessionId]: title }),
    );
  } catch {
    // Losing the launcher listing beats crashing the workspace.
  }
}

function loadPaneState(): PaneState {
  // Defaults follow the side-by-side breakpoints (lg/xl): on narrower
  // screens the panes render as overlay drawers, so they start closed.
  const defaults: PaneState = {
    sources: typeof window !== "undefined" && window.innerWidth >= 1024,
    rail: typeof window !== "undefined" && window.innerWidth >= 1280,
  };
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PANES_STORAGE_KEY) ?? "null",
    ) as Partial<PaneState> | null;
    return {
      sources:
        typeof parsed?.sources === "boolean" ? parsed.sources : defaults.sources,
      rail: typeof parsed?.rail === "boolean" ? parsed.rail : defaults.rail,
    };
  } catch {
    return defaults;
  }
}

/**
 * /studio/:projectId — NotebookLM-style 3-pane workspace around one
 * chat session. Guard lives here (before any other hooks) so legacy
 * `studio-*` deep links from the deprecated M9 feature land home and
 * the inner workspace never renders with an invalid session id.
 */
export function StudioPage() {
  const { projectId } = useParams();
  if (!projectId || !projectId.startsWith("web-")) {
    return <Navigate to="/" replace />;
  }
  // Keyed by project so switching projects remounts the workspace: lazy
  // state initializers (title, panes) re-run and per-project state like
  // the source selection can never leak across sessions.
  return <StudioWorkspace key={projectId} projectId={projectId} />;
}

function StudioWorkspace({ projectId }: { projectId: string }) {
  const [title, setTitle] = useState(() => readStoredTitle(projectId));
  const [panes, setPanes] = useState<PaneState>(loadPaneState);
  const {
    width: sourcesPaneWidthValue,
    effectiveWidth: sourcesPaneWidth,
    onPointerDown: onSourcesResizeStart,
    onKeyDown: onSourcesResizeKeyDown,
  } = useResizablePanel({
    minWidth: 240,
    maxWidth: 480,
    defaultWidth: 280,
    storageKey: "octos_studio_sources_width",
    side: "left",
  });
  const {
    width: studioRailWidthValue,
    effectiveWidth: studioRailWidth,
    onPointerDown: onStudioRailResizeStart,
    onKeyDown: onStudioRailResizeKeyDown,
  } = useResizablePanel({
    minWidth: 280,
    maxWidth: 520,
    defaultWidth: 320,
    storageKey: "octos_studio_rail_width",
    side: "right",
  });
  const [sourcePreviewKey, setSourcePreviewKey] = useState<string | null>(null);
  const [assetPreviewId, setAssetPreviewId] = useState<string | null>(null);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceListScrollTop, setSourceListScrollTop] = useState(0);
  const [citationTarget, setCitationTarget] = useState<CitationTarget | null>(null);

  // Persist only explicit user toggles — a mount must not freeze the
  // viewport-derived defaults into storage as if the user chose them.
  const updatePanes = useCallback((updater: (prev: PaneState) => PaneState) => {
    setPanes((prev) => {
      const next = updater(prev);
      try {
        localStorage.setItem(PANES_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Persistence is best-effort.
      }
      return next;
    });
  }, []);
  const {
    selectedSources,
    uploadedSources,
    sourcesLoading,
    sourcesCapability,
    selectedSourceIds,
    toggleSource,
    mergeUploadedSourceRows,
    renameUploadedSourceRow,
    removeUploadedSourceRow,
    refreshSourceCatalog,
  } = useNotebookSources(projectId);

  function openCitation(citation: CitationTarget) {
    setCitationTarget(citation);
    const row = uploadedSources.find((candidate) =>
      (citation.sourceId && candidate.sourceId === citation.sourceId)
      || (citation.sourcePath && candidate.sourcePath === citation.sourcePath)
    );
    if (!row) return;
    setSourcePreviewKey(row.jobId ?? row.sourceId ?? row.path);
    updatePanes((current) => ({
      ...current,
      sources: true,
      rail: window.innerWidth < 1024 ? false : current.rail,
    }));
  }

  // Title: seed from localStorage, then track the runtime-provider's
  // `crew:session_title_updated` window event (detail is the bridge's
  // `{ session_id, title }` notification payload) plus cross-tab
  // `storage` writes to the shared titles record.
  useEffect(() => {
    // Seed the shared record on mount so the launcher lists this project
    // even before the server ever names the session.
    persistStoredTitle(projectId, readStoredTitle(projectId));
    recordProjectOpened(projectId);
    function onTitleUpdated(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { session_id?: unknown; title?: unknown }
        | undefined;
      if (!detail || detail.session_id !== projectId) return;
      if (typeof detail.title === "string" && detail.title.trim()) {
        setTitle(detail.title);
        persistStoredTitle(projectId, detail.title);
      }
    }
    function onStorage(e: StorageEvent) {
      if (e.key && e.key !== TITLE_STORAGE_KEY) return;
      setTitle(readStoredTitle(projectId));
    }
    window.addEventListener("crew:session_title_updated", onTitleUpdated);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("crew:session_title_updated", onTitleUpdated);
      window.removeEventListener("storage", onStorage);
    };
  }, [projectId]);

  // Studio turns carry both the Notebook routing context and the currently
  // selected catalog paths used for grounding.
  const beforeSend = useCallback(
    async (request: SessionSendRequest): Promise<SessionBeforeSendResult> => {
      const contextual = withNotebookToolContext(request);
      return {
        ...contextual,
        media: mergeSourceMedia(contextual.media ?? [], selectedSources),
      };
    },
    [selectedSources],
  );

  const { queueMode, adaptiveMode } = useModeState();

  // Hand-built pinned session context, per the canonical slides-chat
  // embedding: the session is fixed to this project, every mutator is
  // a no-op, and ChatThread/composer read scope from here.
  const sessionValue = useMemo<SessionContextValue>(
    () => ({
      sessions: [],
      currentSessionId: projectId,
      historyTopic: undefined,
      currentSessionTitle: title,
      currentSessionStats: null,
      initialMessages: [] as never[],
      activeTaskOnServer: false,
      queueMode,
      adaptiveMode,
      setServerTaskActive: () => {},
      renameSession: () => {},
      updateSessionStats: () => {},
      switchSession: () => {},
      goBack: async () => false,
      createSession: () => projectId,
      removeSession: async () => {},
      branchSession: async () => {
        throw new Error("session fork is not available on this surface");
      },
      refreshSessions: async () => {},
      markSessionActive: () => {},
      beforeSend,
    }),
    [adaptiveMode, beforeSend, projectId, queueMode, title],
  );

  return (
    <SessionContext.Provider value={sessionValue}>
      <ScopedRuntimeBridge>
        <div
          className="studio-shell flex h-screen flex-col"
          data-testid="studio-page"
        >
          <StudioNav
            actions={
              <>
                <button
                  type="button"
                  className="studio-ghost-button p-2"
                  aria-label="Toggle sources"
                  aria-pressed={panes.sources}
                  onClick={() =>
                    updatePanes((prev) => ({ ...prev, sources: !prev.sources }))
                  }
                >
                  <PanelLeft size={18} />
                </button>
                <button
                  type="button"
                  className="studio-ghost-button p-2"
                  aria-label="Toggle studio rail"
                  aria-pressed={panes.rail}
                  onClick={() =>
                    updatePanes((prev) => ({ ...prev, rail: !prev.rail }))
                  }
                >
                  <PanelRight size={18} />
                </button>
              </>
            }
          />
          <div className="relative flex min-h-0 flex-1">
            {/* Below the side-by-side breakpoints the open pane becomes a
                fixed drawer over the chat with a click-to-close scrim, so
                the header toggles stay functional at every width. */}
            {panes.sources && (
              <div
                className="studio-scrim lg:hidden"
                aria-hidden="true"
                onClick={() =>
                  updatePanes((prev) => ({ ...prev, sources: false }))
                }
              />
            )}
            {panes.sources && (
              <aside
                style={{ width: sourcesPaneWidth }}
                className="studio-pane shrink-0 border-r max-lg:fixed max-lg:bottom-0 max-lg:left-0 max-lg:top-16 max-lg:z-[35] max-lg:!w-[280px] max-lg:shadow-2xl"
                data-testid="studio-sources-pane"
              >
                <StudioSourcesPane
                  sessionId={projectId}
                  previewKey={sourcePreviewKey}
                  onPreviewKeyChange={setSourcePreviewKey}
                  selected={selectedSourceIds}
                  onToggle={toggleSource}
                  uploaded={uploadedSources}
                  onUploaded={mergeUploadedSourceRows}
                  onRenamed={renameUploadedSourceRow}
                  onRemoved={removeUploadedSourceRow}
                  onCatalogChanged={() => {
                    void refreshSourceCatalog();
                  }}
                  loading={sourcesLoading}
                  query={sourceQuery}
                  onQueryChange={setSourceQuery}
                  listScrollTop={sourceListScrollTop}
                  onListScrollTopChange={setSourceListScrollTop}
                  citationTarget={citationTarget}
                  onCitationTargetClear={() => setCitationTarget(null)}
                  capability={sourcesCapability}
                />
              </aside>
            )}
            {panes.sources && (
              <div
                className="panel-resize-handle max-lg:hidden"
                data-testid="studio-sources-resize-handle"
                title="Resize Sources pane"
                role="separator"
                tabIndex={0}
                aria-label="Resize Sources pane"
                aria-orientation="vertical"
                aria-valuemin={240}
                aria-valuemax={480}
                aria-valuenow={sourcesPaneWidthValue}
                onPointerDown={onSourcesResizeStart}
                onKeyDown={onSourcesResizeKeyDown}
              />
            )}
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="shrink-0 pb-4 pt-8 text-center">
                <h1
                  className="studio-headline px-4 text-3xl"
                  data-testid="studio-title"
                >
                  {title}
                </h1>
                <p className="mt-1.5 text-sm text-muted">
                  Project Workspace · Octos Studio
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <ChatThread allowAttachments={false} />
              </div>
              <p className="shrink-0 pb-2 text-center font-label text-[11px] tracking-[0.05em] text-muted">
                AI responses may vary. Please verify important information.
              </p>
            </main>
            {panes.rail && (
              <div
                className="studio-scrim xl:hidden"
                aria-hidden="true"
                onClick={() =>
                  updatePanes((prev) => ({ ...prev, rail: false }))
                }
              />
            )}
            {panes.rail && (
              <div
                className="panel-resize-handle max-xl:hidden"
                data-testid="studio-rail-resize-handle"
                title="Resize Studio pane"
                role="separator"
                tabIndex={0}
                aria-label="Resize Studio pane"
                aria-orientation="vertical"
                aria-valuemin={280}
                aria-valuemax={520}
                aria-valuenow={studioRailWidthValue}
                onPointerDown={onStudioRailResizeStart}
                onKeyDown={onStudioRailResizeKeyDown}
              />
            )}
            {panes.rail && (
              <aside
                style={{ width: studioRailWidth }}
                className="studio-pane shrink-0 border-l max-xl:fixed max-xl:bottom-0 max-xl:right-0 max-xl:top-16 max-xl:z-[35] max-xl:!w-[320px] max-xl:shadow-2xl"
                data-testid="studio-rail"
              >
                <StudioRail
                  sessionId={projectId}
                  selectedAssetId={assetPreviewId}
                  onSelectedAssetIdChange={setAssetPreviewId}
                  selectedSourceIds={selectedSourceIds}
                  onCitationOpen={openCitation}
                />
              </aside>
            )}
          </div>
        </div>
        <UiProtocolApprovalHost />
        <UiProtocolQuestionHost />
      </ScopedRuntimeBridge>
    </SessionContext.Provider>
  );
}
