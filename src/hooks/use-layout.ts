/**
 * Chat-surface layout preference ("classic" | "workspace").
 *
 * Mirrors the use-theme.ts storage contract: a localStorage key read at
 * first render, a CustomEvent so same-tab listeners update immediately,
 * and the native `storage` event for cross-tab sync. "classic" is the
 * default — the workspace (notebook three-pane) shell is opt-in via
 * Settings → Appearance → Chat Layout, and App.tsx reads this hook to
 * pick which layout wraps the /chat ChatThread.
 */

import { useState, useEffect, useCallback } from "react";

export type AppLayout = "classic" | "workspace";

const STORAGE_KEY = "octos-layout";
const LAYOUT_CHANGE_EVENT = "octos-layout-change";

function isAppLayout(value: unknown): value is AppLayout {
  return value === "classic" || value === "workspace";
}

/** Resolve the active chat layout. Pure: reads storage, mutates nothing. */
export function resolveInitialLayout(): AppLayout {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isAppLayout(stored) ? stored : "classic";
}

/** Persist the preference. */
export function applyLayout(layout: AppLayout): void {
  localStorage.setItem(STORAGE_KEY, layout);
}

export function useLayout() {
  const [layout, setLayoutState] = useState<AppLayout>(resolveInitialLayout);

  useEffect(() => {
    const onLayoutChange = (event: Event) => {
      const next = event instanceof CustomEvent ? event.detail : null;
      if (isAppLayout(next)) {
        setLayoutState(next);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setLayoutState(resolveInitialLayout());
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LAYOUT_CHANGE_EVENT, onLayoutChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setLayout = useCallback((next: AppLayout) => {
    applyLayout(next);
    setLayoutState(next);
    window.dispatchEvent(new CustomEvent(LAYOUT_CHANGE_EVENT, { detail: next }));
  }, []);

  return { layout, setLayout };
}
