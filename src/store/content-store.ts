import { useSyncExternalStore, useEffect } from "react";
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

// --- Bridge: listen for new file events and refresh ---

if (typeof window !== "undefined") {
  window.addEventListener("crew:file", () => {
    // Debounce: wait 2s for potential batch of files
    clearTimeout((window as any).__contentRefreshTimer);
    (window as any).__contentRefreshTimer = setTimeout(refreshContent, 2000);
  });
}
