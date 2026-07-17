/**
 * Workspace chat shell ("notebook" layout): sources left, agent center,
 * artifacts/runs right — the design-mocks/notebook-codex-shell direction
 * shipped as an opt-in alternative to ChatLayout. Selected in Settings →
 * Appearance → Chat Layout (`octos-layout` = "workspace"); App.tsx picks
 * this shell for /chat when the preference is set. Classic stays the
 * default, and everything here reuses the existing runtime — the same
 * OctosRuntimeProvider SessionContext, ChatThread, and studio panes — so
 * the two shells never diverge in protocol behavior.
 *
 * beforeSend grounding: checked sources ride along as turn media on the
 * next send (same contract as the studio workspace). Injected through a
 * nested SessionContext.Provider that spreads the live session value, so
 * the shared runtime provider is never touched.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Mic, PanelLeft, PanelRight, Plus, Target } from "lucide-react";

import type { BackgroundTaskInfo } from "@/api/types";
import { CostBar } from "@/components/cost-bar";
import { RouterFailoverBanner } from "@/components/router-failover-banner";
import { RouterModeSwitcher } from "@/components/router-mode-switcher";
import { SessionAutonomyChip } from "@/components/session-autonomy-chip";
import { SessionTaskIndicator } from "@/components/session-task-dock";
import { SessionTitleEditor } from "@/components/session-title-editor";
import { UiProtocolApprovalHost } from "@/components/ui-protocol-approval-host";
import { UiProtocolQuestionHost } from "@/components/ui-protocol-question-host";
import {
  WorkbenchBrand,
  WorkbenchRouteNav,
  WorkbenchThemeButton,
  WorkbenchUserActions,
} from "@/components/workbench-shell";
import { useOctosStatus } from "@/hooks/use-octos-status";
import {
  SessionContext,
  useSession,
  type SessionBeforeSendResult,
  type SessionContextValue,
  type SessionSendRequest,
} from "@/runtime/session-context";
import { displayLabelForRolled } from "@/runtime/task-rollup";
import { useAutonomyState } from "@/store/autonomy-store";
import { loadSessionFiles } from "@/store/file-store";
import { useTasks } from "@/store/task-store";
import {
  mergeSourceMedia,
  relativeTime,
  type SourceRow,
} from "@/studio/source-media";
import { StudioRail } from "@/studio/studio-rail";
import { StudioSourcesPane } from "@/studio/studio-sources-pane";

const PANES_STORAGE_KEY = "octos-workspace-panes";

interface PaneState {
  sources: boolean;
  rail: boolean;
}

function loadPaneState(): PaneState {
  // Same breakpoint contract as the studio workspace: below the
  // side-by-side widths the panes render as overlay drawers and start
  // closed. Persist only explicit toggles (mirrors studio-page).
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

type RunTone = "default" | "accent" | "success" | "danger";

function runTone(task: BackgroundTaskInfo): RunTone {
  if (task.status === "spawned" || task.status === "running") return "accent";
  if (task.status === "failed") return "danger";
  if (task.status === "completed") return "success";
  return "default";
}

/** Runs tab: this session's background tasks, active first (task-store
 *  already sorts). Reads the same store as the classic header dock. */
function WorkspaceRuns({
  sessionId,
  topic,
}: {
  sessionId: string;
  topic?: string;
}) {
  const tasks = useTasks(sessionId, topic);
  if (tasks.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted">
        No runs yet — background tasks for this workspace show up here.
      </p>
    );
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2"
      data-testid="workspace-runs-list"
    >
      {tasks.map((task) => (
        <div
          key={task.id}
          className="glass-section flex items-center gap-2.5 px-3 py-2"
          data-testid={`workspace-run-${task.id}`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-text">
              {displayLabelForRolled(task)}
            </span>
            <span className="block truncate text-[10px] text-muted">
              {task.error ? task.error : task.tool_name}
              {" · "}
              {relativeTime(new Date(task.started_at).getTime())}
            </span>
          </span>
          <span className="workbench-status-pill shrink-0" data-tone={runTone(task)}>
            {task.status}
          </span>
        </div>
      ))}
    </div>
  );
}

export function WorkspaceLayout({ children }: { children: ReactNode }) {
  const session = useSession();
  const {
    sessions,
    currentSessionId,
    historyTopic,
    currentSessionTitle,
    renameSession,
    switchSession,
    createSession,
  } = session;
  const status = useOctosStatus();
  const navigate = useNavigate();
  const { goal } = useAutonomyState(currentSessionId, historyTopic);

  const [panes, setPanes] = useState<PaneState>(loadPaneState);
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

  const [railTab, setRailTab] = useState<"artifacts" | "runs">("artifacts");
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [uploadedSources, setUploadedSources] = useState<SourceRow[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);

  // Switching sessions resets the source selection (it is scoped to one
  // workspace's files) and reloads that session's file listing. The reset
  // is render-phase state adjustment (React's sanctioned alternative to
  // setState-in-effect); the effect only kicks off the async reload.
  const [loadedSession, setLoadedSession] = useState(currentSessionId);
  if (loadedSession !== currentSessionId) {
    setLoadedSession(currentSessionId);
    setSelectedSources([]);
    setSourcesLoading(true);
  }
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(loadSessionFiles(currentSessionId)).finally(() => {
      if (!cancelled) setSourcesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  const toggleSource = useCallback((path: string) => {
    setSelectedSources((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  }, []);

  const beforeSend = useCallback(
    async (request: SessionSendRequest): Promise<SessionBeforeSendResult> => ({
      ...request,
      media: mergeSourceMedia(request.media, selectedSources),
    }),
    [selectedSources],
  );

  const sessionValue = useMemo<SessionContextValue>(
    () => ({ ...session, beforeSend }),
    [session, beforeSend],
  );

  const liveGoal =
    goal !== null && (goal.status === "active" || goal.status === "paused")
      ? goal
      : null;

  return (
    <SessionContext.Provider value={sessionValue}>
      <div
        className="studio-shell flex h-screen flex-col"
        data-testid="workspace-layout"
      >
        <header className="workbench-topbar shrink-0 px-3">
          <div className="flex min-h-16 flex-wrap items-center gap-2 py-2">
            <button
              type="button"
              className="glass-icon-button p-2"
              aria-label="Toggle sources"
              aria-pressed={panes.sources}
              data-testid="workspace-toggle-sources"
              onClick={() =>
                updatePanes((prev) => ({ ...prev, sources: !prev.sources }))
              }
            >
              <PanelLeft size={16} />
            </button>
            <WorkbenchBrand />
            <WorkbenchRouteNav compact />
            <div className="flex-1" />
            <button
              type="button"
              className="workbench-status-pill"
              data-tone="success"
              onClick={() => navigate("/voice")}
              title="Open the voice console"
            >
              <Mic size={13} />
              Voice
            </button>
            <button
              type="button"
              className="workbench-button flex items-center gap-1.5 px-3 py-2 text-sm font-semibold"
              data-testid="workspace-new-session"
              onClick={() => createSession()}
            >
              <Plus size={14} />
              New workspace
            </button>
            <button
              type="button"
              className="glass-icon-button p-2"
              aria-label="Toggle artifacts and runs"
              aria-pressed={panes.rail}
              data-testid="workspace-toggle-rail"
              onClick={() =>
                updatePanes((prev) => ({ ...prev, rail: !prev.rail }))
              }
            >
              <PanelRight size={16} />
            </button>
            <WorkbenchThemeButton />
            <WorkbenchUserActions />
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 gap-2 px-2 pb-2">
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
              className="studio-pane flex w-[280px] shrink-0 flex-col overflow-hidden rounded-lg max-lg:fixed max-lg:bottom-2 max-lg:left-2 max-lg:top-[4.5rem] max-lg:z-[35] max-lg:shadow-2xl"
              data-testid="workspace-sources-pane"
            >
              <div className="px-3 pt-3">
                <div className="glass-section px-3 py-3">
                  <div className="shell-kicker">Current workspace</div>
                  <select
                    className="mt-2 w-full rounded-lg border border-border bg-surface-container px-2 py-1.5 text-sm text-text"
                    value={currentSessionId}
                    onChange={(event) => switchSession(event.target.value)}
                    aria-label="Switch workspace"
                    data-testid="workspace-session-select"
                  >
                    {sessions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.title || entry.id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <StudioSourcesPane
                  sessionId={currentSessionId}
                  selected={selectedSources}
                  onToggle={toggleSource}
                  uploaded={uploadedSources}
                  onUploaded={(rows) =>
                    setUploadedSources((prev) => [...rows, ...prev])
                  }
                  loading={sourcesLoading}
                />
              </div>
              {liveGoal && (
                <div className="px-3 pb-3">
                  <div className="glass-section px-3 py-3">
                    <div className="shell-kicker">Pinned context</div>
                    <div
                      className="mt-2 flex items-start gap-2"
                      data-testid="workspace-goal-row"
                    >
                      <Target size={14} className="mt-0.5 shrink-0 text-muted" />
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-xs text-text">
                          {liveGoal.objective}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted">
                          goal · {liveGoal.status}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </aside>
          )}

          <main className="glass-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg">
            <div className="px-3 pt-3">
              <div className="glass-toolbar px-4 py-4">
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="shell-kicker">Agent</div>
                    <SessionTitleEditor
                      value={currentSessionTitle}
                      onSave={(title) => renameSession(currentSessionId, title)}
                      buttonClassName="mt-1 w-full pr-3 text-left text-[1.24rem] font-semibold tracking-tight text-text-strong transition hover:text-accent"
                      inputClassName="mt-1 w-full rounded-lg border border-accent/40 bg-surface-container px-3 py-2 text-[1.08rem] font-semibold tracking-tight text-text outline-none"
                      testId="workspace-session-title"
                    />
                  </div>
                  <SessionAutonomyChip />
                  <SessionTaskIndicator />
                </div>
                <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3">
                  <CostBar model={status?.model} provider={status?.provider} />
                  <RouterModeSwitcher />
                </div>
              </div>
            </div>
            <div className="relative flex-1 min-h-0 overflow-hidden px-2 pb-2">
              {children}
              <RouterFailoverBanner />
            </div>
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
            <aside
              className="studio-pane flex w-[320px] shrink-0 flex-col overflow-hidden rounded-lg max-xl:fixed max-xl:bottom-2 max-xl:right-2 max-xl:top-[4.5rem] max-xl:z-[35] max-xl:shadow-2xl"
              data-testid="workspace-rail"
            >
              <div className="flex gap-1 px-3 pt-3" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={railTab === "artifacts"}
                  data-active={railTab === "artifacts" ? "true" : undefined}
                  data-testid="workspace-tab-artifacts"
                  className="studio-ghost-button px-3 py-1.5 text-sm"
                  onClick={() => setRailTab("artifacts")}
                >
                  Artifacts
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={railTab === "runs"}
                  data-active={railTab === "runs" ? "true" : undefined}
                  data-testid="workspace-tab-runs"
                  className="studio-ghost-button px-3 py-1.5 text-sm"
                  onClick={() => setRailTab("runs")}
                >
                  Runs
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {railTab === "artifacts" ? (
                  <StudioRail
                    sessionId={currentSessionId}
                    historyTopic={historyTopic}
                    selectedSources={selectedSources}
                  />
                ) : (
                  <WorkspaceRuns
                    sessionId={currentSessionId}
                    topic={historyTopic}
                  />
                )}
              </div>
            </aside>
          )}
        </div>

        <UiProtocolApprovalHost />
        <UiProtocolQuestionHost />
      </div>
    </SessionContext.Provider>
  );
}
