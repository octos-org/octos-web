import { useState, useEffect } from "react";
import { X, Download, Maximize2, Minimize2 } from "lucide-react";
import { MarkdownContent } from "@/components/markdown-renderer";
import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import type { ContentEntry } from "@/api/content";

interface MarkdownViewerProps {
  entry: ContentEntry;
  onClose: () => void;
}

export function MarkdownViewer({ entry, onClose }: MarkdownViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const token = getToken();
    const url = `${API_BASE}/api/files?path=${encodeURIComponent(entry.path)}`;
    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then(setContent)
      .catch((e) => setError(e.message));
  }, [entry.path]);

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
              href={`${API_BASE}/api/files?path=${encodeURIComponent(entry.path)}`}
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
          ) : (
            <MarkdownContent
              text={content}
              className="prose prose-invert prose-sm max-w-none"
            />
          )}
        </div>
      </div>
    </div>
  );
}
