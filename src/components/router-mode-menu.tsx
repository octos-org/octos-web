import { useEffect, useRef, useState } from "react";
import { Route } from "lucide-react";

import { useSession } from "@/runtime/session-context";
import { RouterModeSwitcher } from "./router-mode-switcher";

const MODE_LABELS: Record<string, string> = {
  off: "Off",
  lane: "Lane",
  hedge: "Hedge",
};

/**
 * Compact entry point for the adaptive router controls in the chat
 * header: a single pill that opens the three-button RouterModeSwitcher
 * in a dropdown. The switcher itself is unchanged (and its unit tests
 * still exercise the full radiogroup); this wrapper keeps the
 * always-visible header to one small control instead of three
 * 10px engineer-facing buttons (2026-08 UI audit).
 */
export function RouterModeMenu() {
  const { adaptiveMode } = useSession();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const modeLabel =
    adaptiveMode !== null ? MODE_LABELS[adaptiveMode] ?? adaptiveMode : null;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        data-testid="router-mode-menu-trigger"
        className="glass-pill flex items-center gap-1.5 rounded-[12px] px-3 py-1.5 text-xs text-muted/80 hover:text-text"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Adaptive router mode"
        onClick={() => setOpen((v) => !v)}
      >
        <Route size={12} className="shrink-0" />
        {modeLabel ? `Route: ${modeLabel}` : "Router"}
      </button>
      {open && (
        <div
          role="menu"
          data-testid="router-mode-menu-popover"
          className="absolute right-0 top-full z-50 mt-1 rounded-[12px] border border-border bg-surface-container p-1.5 shadow-lg"
        >
          <RouterModeSwitcher />
        </div>
      )}
    </div>
  );
}
