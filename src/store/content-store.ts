import { useSyncExternalStore, useEffect } from "react";
// M12 Phase D-3: content library page routes through the Phase D-2
// wrappers in src/api/content.ts. `fetchContent` flips between WS
// `content/list` and REST `GET /api/my/content` under the
// `auxiliary_rest_to_ws_v1` flag; `deleteContent` / `bulkDeleteContent`
// flip between WS `content/delete` + `content/bulk_delete` and REST
// `DELETE /api/my/content/:id` + `POST /api/my/content/bulk-delete`.
// All three wrappers preserve their REST return shapes; the sessionId
// filter is now applied INSIDE the wrapper (in REST mode the wrapper
// post-filters via `matchesContentSession`, in WS mode the server
// pre-filters via `filters.session_id`), so this store no longer
// strips/re-applies the filter itself.
import {
  fetchContent,
  deleteContent as apiDelete,
  bulkDeleteContent as apiBulkDelete,
  type ContentEntry,
  type ContentFilters,
} from "@/api/content";

// --- Internal state ---

let entries: ContentEntry[] = [];
let total = 0;
let loading = false;
let error: string | null = null;
let currentFilters: ContentFilters = {};
let version = 0;

const listeners = new Set<() => void>();
let snapshot: { entries: ContentEntry[]; total: number; loading: boolean; error: string | null } = { entries, total, loading, error };

function notify() {
  version++;
  snapshot = { entries: [...entries], total, loading, error };
  listeners.forEach((fn) => fn());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return snapshot;
}

// --- Public API ---

export async function loadContent(filters: ContentFilters = {}) {
  currentFilters = filters;
  loading = true;
  error = null;
  notify();

  try {
    // M12 Phase D-3: pass `filters` (including `sessionId`) straight to
    // the wrapper. The wrapper now owns the sessionId-to-server mapping
    // (WS: `filters.session_id`) and the legacy path-pattern post-filter
    // (REST), so callers no longer need to strip + re-filter. Keep
    // `loadContent` transport-agnostic.
    // Note: REST path filters within a single page only — see
    // octos-web#105 for full pagination parity follow-up.
    const result = await fetchContent(filters);
    entries = result.entries;
    total = result.total;
    loading = false;
    notify();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    loading = false;
    notify();
  }
}

export async function refreshContent() {
  await loadContent(currentFilters);
}

export async function removeContent(ids: string[]) {
  if (ids.length === 1) {
    await apiDelete(ids[0]);
  } else if (ids.length > 1) {
    await apiBulkDelete(ids);
  }
  await refreshContent();
}

// --- React hook ---

export function useContent() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Load content when filters change. */
export function useContentLoader(filters: ContentFilters) {
  const stableKey = JSON.stringify(filters);
  useEffect(() => {
    loadContent(filters);
  }, [stableKey]);
}

/** Call this after auth is confirmed to load initial content. */
export function initContentStore(filters: ContentFilters = {}) {
  currentFilters = filters;
  if (entries.length === 0 && !loading) {
    loadContent(filters);
  }
}

// --- Bridge for new file events ---

if (typeof window !== "undefined") {
  window.addEventListener("crew:file", () => {
    // Debounce: wait 2s for potential batch of files
    clearTimeout((window as any).__contentRefreshTimer);
    (window as any).__contentRefreshTimer = setTimeout(refreshContent, 2000);
  });
}
