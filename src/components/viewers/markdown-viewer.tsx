import { useState, useEffect, useCallback } from "react";
import { X, Download, Maximize2, Minimize2 } from "lucide-react";
import { MarkdownContent } from "@/components/markdown-renderer";
import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import type { ContentEntry } from "@/api/content";
import { useSession } from "@/runtime/session-context";

interface MarkdownViewerProps {
  entry: ContentEntry;
  onClose: () => void;
}

export function MarkdownViewer({ entry, onClose }: MarkdownViewerProps) {
  const { currentSessionId, historyTopic } = useSession();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const isMarkdownLike = /\.(md|markdown|txt)$/i.test(entry.filename);

  const loadContent = useCallback(() => {
    const url = buildFileUrl(entry.path);
    setError(null);
    fetch(url, {
      headers: buildApiHeaders(),
    })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then(setContent)
      .catch((e) => setError(e.message));
  }, [entry.path]);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  useEffect(() => {
    const sessionId = entry.session_id;
    if (!sessionId) return;

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    function matchesSession(detail: unknown): boolean {
      if (
        !detail ||
        typeof detail !== "object" ||
        !("sessionId" in detail) ||
        detail.sessionId !== sessionId
      ) {
        return false;
      }
      if (
        sessionId === currentSessionId &&
        historyTopic &&
        "topic" in detail &&
        typeof detail.topic === "string" &&
        detail.topic !== historyTopic
      ) {
        return false;
      }
      return true;
    }

    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        loadContent();
      }, 500);
    }

    function handleEvent(event: Event) {
      const detail =
        event instanceof CustomEvent ? (event.detail as unknown) : undefined;
      if (!matchesSession(detail)) return;
      scheduleRefresh();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        scheduleRefresh();
      }
    }

    window.addEventListener("focus", scheduleRefresh);
    window.addEventListener("crew:file", handleEvent);
    window.addEventListener("crew:bg_tasks", handleEvent);
    window.addEventListener("crew:task_status", handleEvent);
    window.addEventListener("crew:tool_progress", handleEvent);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener("focus", scheduleRefresh);
      window.removeEventListener("crew:file", handleEvent);
      window.removeEventListener("crew:bg_tasks", handleEvent);
      window.removeEventListener("crew:task_status", handleEvent);
      window.removeEventListener("crew:tool_progress", handleEvent);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentSessionId, entry.session_id, historyTopic, loadContent]);

  // Escape key closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const panelClass = maximized
    ? "fixed inset-0 z-50 flex flex-col bg-surface-dark"
    : "fixed inset-0 z-50 flex items-center justify-center bg-black/60";

  const cardClass = maximized
    ? "flex h-full w-full flex-col"
    : "relative flex h-[85vh] w-[90vw] max-w-4xl flex-col rounded-2xl bg-surface-dark shadow-2xl";

  return (
    <div className={panelClass} onClick={maximized ? undefined : onClose}>
      <div className={cardClass} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="truncate text-sm font-medium text-text">{entry.filename}</h3>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setMaximized(!maximized)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-container hover:text-accent"
              title={maximized ? "Restore" : "Maximize"}
            >
              {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <a
              href={buildFileUrl(entry.path)}
              download={entry.filename}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-container hover:text-accent"
              title="Download"
            >
              <Download size={16} />
            </a>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-container hover:text-text"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error ? (
            <div className="text-sm text-red-400">Failed to load: {error}</div>
          ) : content === null ? (
            <div className="text-sm text-muted animate-pulse">Loading...</div>
          ) : isMarkdownLike ? (
            <MarkdownContent
              text={content}
              className="prose prose-invert prose-sm max-w-none"
            />
          ) : (
            <pre className="overflow-x-auto rounded-2xl border border-border bg-surface px-4 py-4 text-xs leading-6 text-text">
              <code>{content}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
