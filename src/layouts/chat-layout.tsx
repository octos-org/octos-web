import { type ReactNode, useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/auth/auth-context";
import { useOctosStatus } from "@/hooks/use-octos-status";
import { useTheme } from "@/hooks/use-theme";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { CostBar } from "@/components/cost-bar";
import { SessionList } from "@/components/session-list";
import { ContentBrowser } from "@/components/content-browser";
import { SessionTaskIndicator } from "@/components/session-task-dock";
import { useSession } from "@/runtime/session-context";
import { eventMatchesScope } from "@/runtime/event-scope";
import {
  useContentViewer,
  ContentViewerOverlay,
} from "@/components/content-viewer";
import { LogOut, Sun, Moon, Settings, PanelRight } from "lucide-react";
import { useFileStore } from "@/store/file-store";

export function ChatLayout({ children }: { children: ReactNode }) {
  const { user, portal, logout } = useAuth();
  const { currentSessionId, currentSessionTitle, historyTopic, renameSession } =
    useSession();
  const status = useOctosStatus();
  const { theme, toggleTheme } = useTheme();
  const [mediaPanelOpen, setMediaPanelOpen] = useState(false);
  const sessionFiles = useFileStore(currentSessionId);
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
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openPanel = useCallback(() => setMediaPanelOpen(true), []);
  const clearToastTimer = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);
  const dismissToast = useCallback(() => {
    clearToastTimer();
    setToast(null);
  }, [clearToastTimer]);

  // Listen for crew:file to show toast (crew:file_notification is a secondary
  // event dispatched by the file-store itself, so listening to both caused
  // duplicate toasts).
  useEffect(() => {
    function onFile(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      const filename = detail?.filename || "file";
      const isAudio = /\.(mp3|wav|ogg|m4a|opus|flac|aac)$/i.test(filename);
      setToast(isAudio ? `🎵 Audio ready: ${filename}` : `📄 File ready: ${filename}`);
      clearToastTimer();
      toastTimerRef.current = setTimeout(() => {
        toastTimerRef.current = null;
        setToast(null);
      }, 8000);
    }
    window.addEventListener("crew:file", onFile);
    return () => {
      window.removeEventListener("crew:file", onFile);
    };
  }, [clearToastTimer, currentSessionId, historyTopic]);

  useEffect(() => {
    return dismissToast;
  }, [currentSessionId, dismissToast, historyTopic]);

  return (
    <div className="chat-shell flex h-screen gap-3 p-3">
      {/* Sidebar */}
      <aside
        style={{ width: historyPanelWidth }}
        className="sidebar-scope glass-panel flex shrink-0 flex-col overflow-hidden rounded-[16px]"
      >
        {/* Header */}
        <div className="px-3 pt-3">
          <div className="glass-toolbar rounded-[14px] px-4 py-4">
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
                  className="glass-icon-button rounded-[12px] p-2.5"
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
          <div className="glass-section rounded-[12px] px-4 py-3">
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
                    <button
                      onClick={() =>
                        window.open("/admin/my", "_blank", "noopener,noreferrer")
                      }
                      className="glass-icon-button rounded-[10px] p-2"
                      title="Settings"
                      aria-label="Settings"
                    >
                      <Settings size={14} />
                    </button>
                  )}
                  <button
                    onClick={logout}
                    className="glass-icon-button rounded-[10px] p-2"
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
      <div className="flex flex-1 min-w-0 min-h-0 gap-3">
        <main className="glass-panel flex flex-1 min-w-0 flex-col min-h-0 overflow-hidden rounded-[16px]">
          {/* Top bar with title + cost + files toggle */}
          <div className="px-3 pt-3">
            <div className="glass-toolbar rounded-[14px] px-4 py-4">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="shell-kicker">Current Session</div>
                  <div className="truncate pr-3 text-[1.24rem] font-semibold tracking-tight text-text-strong">
                    {currentSessionTitle}
                  </div>
                </div>
                <SessionTaskIndicator />
                <button
                  onClick={() => setMediaPanelOpen((v) => !v)}
                  className={`glass-icon-button relative rounded-[12px] p-2.5 ${
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
              <div className="mt-3 min-w-0">
                <CostBar model={status?.model} provider={status?.provider} />
              </div>
            </div>
          </div>
          <div className="relative flex-1 min-h-0 overflow-hidden px-2 pb-2">
            {children}
            {/* Inline toast notification */}
            {toast && (
              <button
                data-testid="file-notification-toast"
                onClick={openPanel}
                className="glass-pill absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-[12px] px-4 py-2.5 text-sm text-text shadow-lg hover:text-text-strong"
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
              className="shrink-0 overflow-hidden"
            >
              <ContentBrowser
                open={mediaPanelOpen}
                onClose={() => setMediaPanelOpen(false)}
                isMaximized={isMaximized}
                onToggleMaximize={toggleMaximize}
                onOpenViewer={openViewer}
                sessionId={currentSessionId}
                sessionTitle={currentSessionTitle}
                onRenameTitle={(title) => renameSession(currentSessionId, title)}
              />
            </div>
          </>
        )}
      </div>

      {/* Maximized content panel — covers entire window including sidebar */}
      {mediaPanelOpen && isMaximized && (
        <div className="glass-backdrop fixed inset-0 z-40 p-3">
          <ContentBrowser
            open={mediaPanelOpen}
            onClose={() => { setMediaPanelOpen(false); toggleMaximize(); }}
            isMaximized={isMaximized}
            onToggleMaximize={toggleMaximize}
            onOpenViewer={openViewer}
            sessionId={currentSessionId}
            sessionTitle={currentSessionTitle}
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
    </div>
  );
}
