import { type ReactNode, useState, useEffect, useCallback } from "react";
import { useAuth } from "@/auth/auth-context";
import { useOctosStatus } from "@/hooks/use-octos-status";
import { useTheme } from "@/hooks/use-theme";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { CostBar } from "@/components/cost-bar";
import { SessionList } from "@/components/session-list";
import { ContentBrowser } from "@/components/content-browser";
import { useSession } from "@/runtime/session-context";
import {
  useContentViewer,
  ContentViewerOverlay,
} from "@/components/content-viewer";
import { LogOut, Sun, Moon, Settings, PanelRight } from "lucide-react";
import { useFileStore } from "@/store/file-store";

export function ChatLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { currentSessionId, currentSessionTitle, renameSession } = useSession();
  const status = useOctosStatus();
  const { theme, toggleTheme } = useTheme();
  const [mediaPanelOpen, setMediaPanelOpen] = useState(false);
  const sessionFiles = useFileStore(currentSessionId);
  const { effectiveWidth, isMaximized, onMouseDown, toggleMaximize } =
    useResizablePanel();
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
  }, []);

  return (
    <div className="flex h-screen bg-surface-dark">
      {/* Sidebar */}
      <aside className="sidebar-scope flex w-72 flex-col bg-sidebar">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-5">
          <span className="text-lg font-semibold tracking-tight text-text-strong">octos</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={toggleTheme}
              className="rounded-xl p-2 text-muted hover:bg-surface-container hover:text-text-strong"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </div>

        {/* Session list */}
        <SessionList />

        {/* Footer */}
        <div className="px-5 py-4">
          {status && status.model && status.model !== "none" && (
            <div className="mb-2 text-[11px] text-muted/70">
              {status.provider !== "none" ? `${status.provider}/` : ""}{status.model}
            </div>
          )}
          {user && (
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm text-text">{user.email}</span>
                <button
                  onClick={() => window.location.assign("/admin/my")}
                  className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-surface-container hover:text-text-strong"
                  title="Settings"
                  aria-label="Settings"
                >
                  <Settings size={14} />
                </button>
              </div>
              <button
                onClick={logout}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-container hover:text-text-strong"
              >
                <LogOut size={14} />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main + Media Panel */}
      <div className="flex flex-1 min-w-0 min-h-0">
        <main className="flex flex-1 min-w-0 flex-col min-h-0">
          {/* Top bar with title + cost + files toggle */}
          <div className="border-b border-border/60 bg-surface-dark">
            <div className="flex items-center px-5 pt-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-lg font-bold text-text-strong">
                  {currentSessionTitle}
                </div>
              </div>
              <button
                onClick={() => setMediaPanelOpen((v) => !v)}
                className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                  mediaPanelOpen
                    ? "bg-accent/20 text-accent"
                    : "text-muted hover:bg-surface-container hover:text-text-strong"
                }`}
                title={mediaPanelOpen ? "Close files panel" : "Open files panel"}
              >
                <PanelRight size={16} />
                {sessionFiles.length > 0 && !mediaPanelOpen && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-white">
                    {sessionFiles.length}
                  </span>
                )}
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <CostBar model={status?.model} provider={status?.provider} />
            </div>
          </div>
          <div className="relative flex-1 min-h-0 overflow-hidden">
            {children}
            {/* Inline toast notification */}
            {toast && (
              <button
                onClick={openPanel}
                className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-xl bg-surface-elevated px-4 py-2.5 text-sm text-text shadow-lg border border-border animate-in fade-in slide-in-from-bottom-2 duration-300 hover:bg-surface-container cursor-pointer"
              >
                <span>{toast}</span>
                <span className="text-xs text-accent font-medium">Open</span>
              </button>
            )}
          </div>
        </main>

        {/* Content side panel with resize handle */}
        {mediaPanelOpen && !isMaximized && (
          <>
            <div
              onMouseDown={onMouseDown}
              className="w-1 cursor-col-resize bg-transparent hover:bg-accent/30 transition-colors"
            />
            <div
              style={{ width: effectiveWidth }}
              className="shrink-0 overflow-hidden border-l border-border"
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
        <div className="fixed inset-0 z-40 bg-sidebar">
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
