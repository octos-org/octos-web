import { type ReactNode, useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/auth/auth-context";
import { useOctosStatus } from "@/hooks/use-octos-status";
import { useTheme } from "@/hooks/use-theme";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { CostBar } from "@/components/cost-bar";
import { RouterModeSwitcher } from "@/components/router-mode-switcher";
import { RouterFailoverBanner } from "@/components/router-failover-banner";
import { SessionList } from "@/components/session-list";
import { ContentBrowser } from "@/components/content-browser";
import { SessionTitleEditor } from "@/components/session-title-editor";
import { SessionTaskIndicator } from "@/components/session-task-dock";
import { UiProtocolApprovalHost } from "@/components/ui-protocol-approval-host";
import { useSession } from "@/runtime/session-context";
import { eventMatchesScope } from "@/runtime/event-scope";
import {
  useContentViewer,
  ContentViewerOverlay,
} from "@/components/content-viewer";
import { LogOut, Sun, Moon, Settings, PanelRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useFileStore } from "@/store/file-store";

function SettingsNavButton() {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate("/settings")}
      className="glass-icon-button p-2"
      title="Settings"
      aria-label="Settings"
    >
      <Settings size={14} />
    </button>
  );
}

export function ChatLayout({ children }: { children: ReactNode }) {
  const { user, portal, logout } = useAuth();
  const { sessions, currentSessionId, currentSessionTitle, historyTopic, renameSession } =
    useSession();
  const status = useOctosStatus();
  const { theme, toggleTheme } = useTheme();
  const [mediaPanelOpen, setMediaPanelOpen] = useState(false);
  const sessionFiles = useFileStore(currentSessionId);
  const sessionLabels = useMemo(
    () =>
      Object.fromEntries(
        sessions.map((session) => [session.id, session.title || session.id]),
      ),
    [sessions],
  );
  const {
    effectiveWidth,
    isMaximized,
    onMouseDown,
    toggleMaximize,
  } =
    useResizablePanel();
  const {
    effectiveWidth: historyPanelWidth,
    onMouseDown: onHistoryPanelMouseDown,
  } = useResizablePanel({
    minWidth: 240,
    maxWidth: 520,
    defaultWidth: 288,
    storageKey: "octos_history_panel_width",
    side: "left",
  });
  const { state: viewerState, openViewer, closeViewer, closeAudio } =
    useContentViewer();

  // Notification toast state
  const [toast, setToast] = useState<string | null>(null);

  const openPanel = useCallback(() => setMediaPanelOpen(true), []);

  // Listen for crew:file to show toast (crew:file_notification is a secondary
  // event dispatched by the file-store itself, so listening to both caused
  // duplicate toasts).
  useEffect(() => {
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    function onFile(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      const filename = detail?.filename || "file";
      const isAudio = /\.(mp3|wav|ogg|m4a|opus|flac|aac)$/i.test(filename);
      setToast(isAudio ? `🎵 Audio ready: ${filename}` : `📄 File ready: ${filename}`);
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setToast(null), 8000);
    }
    window.addEventListener("crew:file", onFile);
    return () => {
      window.removeEventListener("crew:file", onFile);
      if (toastTimer) clearTimeout(toastTimer);
    };
  }, [currentSessionId, historyTopic]);

  return (
    <div className="chat-shell workbench-shell flex h-screen gap-2 p-2">
      {/* Sidebar */}
      <aside
        style={{ width: historyPanelWidth }}
        className="sidebar-scope glass-panel animate-shell-rise flex shrink-0 flex-col overflow-hidden rounded-lg"
      >
        {/* Header */}
        <div className="px-3 pt-3">
          <div className="glass-toolbar px-4 py-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="shell-kicker">Octos Workspace</div>
                <div className="mt-1 text-xl font-semibold tracking-tight text-text-strong">
                  Chat History
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleTheme}
                  className="glass-icon-button p-2.5"
                  title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                  aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                >
                  {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Session list */}
        <SessionList />

        {/* Footer */}
        <div className="px-3 pb-3 pt-2">
          <div className="glass-section rounded-lg px-4 py-3">
            {status && status.model && status.model !== "none" && (
              <div className="mb-2 text-[11px] text-muted/75">
                {status.provider !== "none" ? `${status.provider}/` : ""}{status.model}
              </div>
            )}
            {user && (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text">
                    {user.email}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {portal?.can_access_admin_portal && (
                    <SettingsNavButton />
                  )}
                  <button
                    onClick={logout}
                    className="glass-icon-button p-2"
                    title="Log out"
                    aria-label="Log out"
                  >
                    <LogOut size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
      <div
        onMouseDown={onHistoryPanelMouseDown}
        className="panel-resize-handle"
        title="Resize chat history"
      />

      {/* Main + Media Panel */}
      <div className="flex flex-1 min-w-0 min-h-0 gap-2">
        <main className="glass-panel animate-shell-rise flex flex-1 min-w-0 flex-col min-h-0 overflow-hidden rounded-lg">
          {/* Top bar with title + cost + files toggle */}
          <div className="px-3 pt-3">
            <div className="glass-toolbar px-4 py-4">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="shell-kicker">Current Session</div>
                  <SessionTitleEditor
                    value={currentSessionTitle}
                    onSave={(title) => renameSession(currentSessionId, title)}
                    buttonClassName="mt-1 w-full pr-3 text-left text-[1.24rem] font-semibold tracking-tight text-text-strong transition hover:text-accent"
                    inputClassName="mt-1 w-full rounded-lg border border-accent/40 bg-surface-container px-3 py-2 text-[1.08rem] font-semibold tracking-tight text-text outline-none"
                    testId="chat-session-title"
                  />
                </div>
                <SessionTaskIndicator />
                <button
                  onClick={() => setMediaPanelOpen((v) => !v)}
                  className={`glass-icon-button relative p-2.5 ${
                    mediaPanelOpen ? "is-active" : ""
                  }`}
                  title={mediaPanelOpen ? "Close files panel" : "Open files panel"}
                >
                  <PanelRight size={16} />
                  {sessionFiles.length > 0 && !mediaPanelOpen && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white shadow-lg">
                      {sessionFiles.length}
                    </span>
                  )}
                </button>
              </div>
              <div className="mt-3 min-w-0 flex flex-wrap items-center gap-3">
                <CostBar model={status?.model} provider={status?.provider} />
                {/* Wave4-A router mode switcher. Anchored next to the
                    cost-bar so the live model + cost + routing mode
                    surface as a single block. */}
                <RouterModeSwitcher />
              </div>
            </div>
          </div>
          <div className="relative flex-1 min-h-0 overflow-hidden px-2 pb-2">
            {children}
            {/* Wave4-A router failover banner — auto-dismisses after 4 s. */}
            <RouterFailoverBanner />
            {/* Inline toast notification */}
            {toast && (
              <button
                onClick={openPanel}
                className="glass-pill absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg px-4 py-2.5 text-sm text-text shadow-lg hover:text-text-strong"
              >
                <span>{toast}</span>
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">View</span>
              </button>
            )}
          </div>
        </main>

        {/* Content side panel with resize handle */}
        {mediaPanelOpen && !isMaximized && (
          <>
            <div
              onMouseDown={onMouseDown}
              className="panel-resize-handle"
            />
            <div
              style={{ width: effectiveWidth }}
              className="animate-shell-rise shrink-0 overflow-hidden transition-[width,opacity,transform] duration-200 ease-out"
            >
              <ContentBrowser
                open={mediaPanelOpen}
                onClose={() => setMediaPanelOpen(false)}
                isMaximized={isMaximized}
                onToggleMaximize={toggleMaximize}
                onOpenViewer={openViewer}
                sessionId={currentSessionId}
                sessionTitle={currentSessionTitle}
                sessionLabels={sessionLabels}
                onRenameTitle={(title) => renameSession(currentSessionId, title)}
              />
            </div>
          </>
        )}
      </div>

      {/* Maximized content panel — covers entire window including sidebar */}
      {mediaPanelOpen && isMaximized && (
        <div className="glass-backdrop animate-shell-rise fixed inset-0 z-40 p-3">
          <ContentBrowser
            open={mediaPanelOpen}
            onClose={() => { setMediaPanelOpen(false); toggleMaximize(); }}
            isMaximized={isMaximized}
            onToggleMaximize={toggleMaximize}
            onOpenViewer={openViewer}
            sessionId={currentSessionId}
            sessionTitle={currentSessionTitle}
            sessionLabels={sessionLabels}
            onRenameTitle={(title) => renameSession(currentSessionId, title)}
          />
        </div>
      )}

      {/* Content viewer overlays (image album, video) */}
      <ContentViewerOverlay
        state={viewerState}
        onClose={closeViewer}
        onCloseAudio={closeAudio}
      />
      <UiProtocolApprovalHost />
    </div>
  );
}
