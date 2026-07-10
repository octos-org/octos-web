// Memory tab — read-only viewer over `/api/my/memory*` (web parity
// audit P3 item 6: the book gives the memory system top-3 prominence,
// but the dashboard had zero memory UX). Writes stay with the agent
// tools and the refresh pipeline; this surface only renders what the
// profile's own data dir holds: MEMORY.md, today's + recent daily
// notes, the entity bank, and the refresh pipeline status.
import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Loader2,
  NotebookPen,
  RefreshCw,
  Users,
} from "lucide-react";

import { MarkdownContent } from "@/components/markdown-renderer";
import {
  formatSettingsError,
  getMyMemory,
  getMyMemoryEntity,
  type MemoryOverview,
} from "./settings-api";

function formatUpdatedAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString();
}

/** One collapsible daily-note row (recent notes default collapsed). */
function DailyNoteRow({
  date,
  content,
  truncated,
  totalBytes,
}: {
  date: string;
  content: string;
  truncated?: boolean;
  totalBytes?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-container/60 transition"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">{date}</span>
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 py-2">
          <MarkdownContent text={content} className="text-sm" />
          <TruncationNotice
            truncated={truncated}
            totalBytes={totalBytes}
            shownBytes={content.length}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Honest-cap notice (octos #1621 codex r1): the server declares when a
 *  document field was capped to fit the WS frame; surface it instead of
 *  letting a silently shorter document masquerade as complete. */
function TruncationNotice({
  truncated,
  totalBytes,
  shownBytes,
}: {
  truncated?: boolean;
  totalBytes?: number;
  shownBytes: number;
}) {
  if (!truncated) return null;
  const fmt = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
  return (
    <p className="mt-2 text-xs text-muted" data-testid="memory-truncation-notice">
      Showing the first {fmt(shownBytes)}
      {typeof totalBytes === "number" ? ` of ${fmt(totalBytes)}` : ""} — large
      documents are capped in this panel.
    </p>
  );
}

/** One entity row; the full page is fetched lazily on expand. */
function EntityRow({ name, summary }: { name: string; summary: string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<{
    content: string;
    truncated?: boolean;
    totalBytes?: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || page !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await getMyMemoryEntity(name);
      setPage({
        content: resp.content,
        truncated: resp.content_truncated,
        totalBytes: resp.content_total_bytes,
      });
    } catch (err) {
      setError(formatSettingsError(err, "Failed to load entity page."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-container/60 transition"
        onClick={() => void toggle()}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="min-w-0">
          <span className="block text-sm font-medium">{name}</span>
          {summary ? (
            <span className="block truncate text-xs text-muted">
              {summary}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 py-2">
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : error ? (
            <p className="py-2 text-sm text-red-400">{error}</p>
          ) : (
            <>
              <MarkdownContent text={page?.content ?? ""} className="text-sm" />
              <TruncationNotice
                truncated={page?.truncated}
                totalBytes={page?.totalBytes}
                shownBytes={page?.content.length ?? 0}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function MemoryTab() {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await getMyMemory());
    } catch (err) {
      setError(formatSettingsError(err, "Failed to load memory."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !overview) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading memory…
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="glass-section space-y-3 p-5">
        <p className="text-sm text-red-400">{error}</p>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-text-strong hover:border-accent/30 transition"
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!overview) return null;

  const updatedAt = formatUpdatedAt(overview.long_term_updated_at);
  // Reload failure with a snapshot on screen: keep the snapshot but
  // say it's stale (codex web#265 r1 P2) — the blocking error screen
  // above only covers the nothing-loaded-yet case.
  const reloadError = error;
  const hasAnything =
    overview.long_term.trim() !== "" ||
    overview.today.trim() !== "" ||
    overview.recent.length > 0 ||
    overview.entities.length > 0;

  return (
    <div className="space-y-5">
      {/* Status header: refresh pipeline + staging */}
      <section className="glass-section p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="workbench-icon-tile flex h-10 w-10 shrink-0 items-center justify-center">
            <Brain size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Memory</h3>
            <p className="text-xs text-muted">
              What the agent remembers about you and your projects — long-term
              notes, daily notes, and the entity bank.
            </p>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              overview.refresh_enabled
                ? "bg-emerald-500/15 text-emerald-500"
                : "bg-surface-dark/60 text-muted"
            }`}
            data-testid="memory-refresh-state"
          >
            refresh {overview.refresh_enabled ? "on" : "off"}
          </span>
          {overview.staging_notes > 0 ? (
            <span
              className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-500"
              data-testid="memory-staging-count"
            >
              {overview.staging_notes} staged note
              {overview.staging_notes === 1 ? "" : "s"}
            </span>
          ) : null}
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-text-strong hover:border-accent/30 disabled:opacity-40 transition"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Reload
          </button>
        </div>
        {reloadError ? (
          <p
            className="mt-3 text-xs text-red-400"
            data-testid="memory-reload-error"
          >
            {reloadError} Showing the last loaded snapshot.
          </p>
        ) : null}
      </section>

      {!hasAnything ? (
        <section className="glass-section p-5">
          <p className="text-sm text-muted">
            Nothing here yet. Memory builds up as you chat — ask the agent to
            remember something, or just keep working and the refresh pipeline
            will consolidate what matters.
          </p>
        </section>
      ) : null}

      {/* Long-term MEMORY.md */}
      {overview.long_term.trim() !== "" ? (
        <section className="glass-section p-5">
          <div className="mb-3 flex items-center gap-2">
            <NotebookPen size={15} />
            <h4 className="text-sm font-semibold">Long-term memory</h4>
            {updatedAt ? (
              <span className="ml-auto text-xs text-muted">
                updated {updatedAt}
              </span>
            ) : null}
          </div>
          <MarkdownContent text={overview.long_term} className="text-sm" />
          <TruncationNotice
            truncated={overview.long_term_truncated}
            totalBytes={overview.long_term_total_bytes}
            shownBytes={overview.long_term.length}
          />
        </section>
      ) : null}

      {/* Daily notes */}
      {overview.today.trim() !== "" || overview.recent.length > 0 ? (
        <section className="glass-section p-5">
          <div className="mb-3 flex items-center gap-2">
            <CalendarDays size={15} />
            <h4 className="text-sm font-semibold">Daily notes</h4>
          </div>
          {overview.today.trim() !== "" ? (
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium text-muted">Today</p>
              <MarkdownContent text={overview.today} className="text-sm" />
              <TruncationNotice
                truncated={overview.today_truncated}
                totalBytes={overview.today_total_bytes}
                shownBytes={overview.today.length}
              />
            </div>
          ) : null}
          {overview.recent.length > 0 ? (
            <div className="space-y-2">
              {overview.recent.map((note) => (
                <DailyNoteRow
                  key={note.date}
                  date={note.date}
                  content={note.content}
                  truncated={note.content_truncated}
                  totalBytes={note.content_total_bytes}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Entity bank */}
      {overview.entities.length > 0 ? (
        <section className="glass-section p-5">
          <div className="mb-3 flex items-center gap-2">
            <Users size={15} />
            <h4 className="text-sm font-semibold">Entity bank</h4>
            <span className="text-xs text-muted">
              {overview.entities.length}
            </span>
          </div>
          <div className="space-y-2">
            {overview.entities.map((entity) => (
              <EntityRow key={entity.name} name={entity.name} summary={entity.summary} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
