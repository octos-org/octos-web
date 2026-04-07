import { useState, useCallback, useEffect } from "react";
import { X, Maximize2, Minimize2, Download, Trash2, Loader2 } from "lucide-react";
import type { ContentEntry, ContentFilters } from "@/api/content";
import { downloadContent } from "@/api/content";
import {
  useContent,
  useContentLoader,
  removeContent,
} from "@/store/content-store";
import {
  ContentFilterBar,
  type ViewMode,
} from "@/components/content-filter-bar";
import { ContentList } from "@/components/content-list";
import { ContentGrid, ContentCoverFlow } from "@/components/content-grid";
import { AudioPlayer } from "@/components/viewers/audio-player";

interface ContentBrowserProps {
  open: boolean;
  onClose: () => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onOpenViewer: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
  sessionId: string;
}

export function ContentBrowser({
  open,
  onClose,
  isMaximized,
  onToggleMaximize,
  onOpenViewer,
  sessionId,
}: ContentBrowserProps) {
  const [filters, setFilters] = useState<ContentFilters>({
    sort: "newest",
    limit: 100,
    sessionId,
  });
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem("octos_view_mode") as ViewMode) || "list";
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [audioEntry, setAudioEntry] = useState<ContentEntry | null>(null);

  useEffect(() => {
    setFilters((prev) => {
      if (prev.sessionId === sessionId) return prev;
      return {
        ...prev,
        sessionId,
        offset: 0,
      };
    });
  }, [sessionId]);

  useContentLoader(filters);
  const { entries, total, loading, error } = useContent();

  const handleViewChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("octos_view_mode", mode);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await removeContent([id]);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await removeContent(ids);
    setSelected(new Set());
  }, [selected]);

  const handleBulkDownload = useCallback(() => {
    const selectedEntries = entries.filter((e) => selected.has(e.id));
    selectedEntries.forEach((e) => downloadContent(e));
  }, [entries, selected]);

  const handleOpen = useCallback(
    (entry: ContentEntry) => {
      // Audio plays inline in this panel
      if (entry.category === "audio") {
        setAudioEntry(entry);
        return;
      }
      onOpenViewer(entry, entries);
    },
    [entries, onOpenViewer],
  );

  if (!open) return null;

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-text">Content</h2>
          {total > 0 && (
            <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              {total}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleMaximize}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-container hover:text-text"
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-container hover:text-text"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Inline audio player (above filters) */}
      {audioEntry && (
        <AudioPlayer entry={audioEntry} onClose={() => setAudioEntry(null)} />
      )}

      {/* Filters */}
      <div className="pt-2">
        <ContentFilterBar
          filters={filters}
          onChange={setFilters}
          viewMode={viewMode}
          onViewChange={handleViewChange}
        />
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto py-2">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted" />
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-red-400">
            {error}
          </div>
        ) : viewMode === "list" ? (
          <ContentList
            entries={entries}
            selected={selected}
            onToggleSelect={toggleSelect}
            onOpen={handleOpen}
            onDelete={handleDelete}
          />
        ) : viewMode === "grid" ? (
          <ContentGrid
            entries={entries}
            selected={selected}
            onToggleSelect={toggleSelect}
            onOpen={handleOpen}
          />
        ) : (
          <ContentCoverFlow
            entries={entries}
            selected={selected}
            onToggleSelect={toggleSelect}
            onOpen={handleOpen}
          />
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between border-t border-border bg-surface-container px-3 py-2">
          <span className="text-xs text-muted">
            {selected.size} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={handleBulkDownload}
              className="flex items-center gap-1 rounded-lg bg-accent/20 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/30"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </button>
            <button
              onClick={handleBulkDelete}
              className="flex items-center gap-1 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
