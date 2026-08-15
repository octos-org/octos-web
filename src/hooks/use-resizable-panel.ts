import { useState, useCallback, useEffect, useRef } from "react";

interface ResizablePanelOptions {
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  storageKey?: string;
  side?: "left" | "right";
}

const KEYBOARD_STEP = 16;

/**
 * Resizable side-panel hook.
 *
 * - Pointer Events (pointerdown/move/up) so drag works with mouse, touch
 *   and pen — the old mouse-only listeners made the handles dead on
 *   touch devices (2026-08 UI audit N9).
 * - Keyboard support: spread `handleProps` onto the handle element to
 *   make it a `role="separator"` with ArrowLeft/ArrowRight resizing.
 */
export function useResizablePanel({
  minWidth = 280,
  maxWidth = 900,
  defaultWidth = 360,
  storageKey = "octos_panel_width",
  side = "right",
}: ResizablePanelOptions = {}) {
  const [width, setWidth] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const n = parseInt(saved, 10);
        if (n >= minWidth && n <= maxWidth) return n;
      }
    }
    return defaultWidth;
  });

  const [isMaximized, setIsMaximized] = useState(false);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Persist width
  useEffect(() => {
    if (storageKey && !isMaximized) {
      localStorage.setItem(storageKey, String(width));
    }
  }, [width, storageKey, isMaximized]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;

      const onPointerMove = (ev: PointerEvent) => {
        if (!isDragging.current) return;
        const delta =
          side === "right"
            ? startX.current - ev.clientX
            : ev.clientX - startX.current;
        const newWidth = Math.min(
          maxWidth,
          Math.max(minWidth, startWidth.current + delta),
        );
        setWidth(newWidth);
      };

      const onPointerUp = () => {
        isDragging.current = false;
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, minWidth, maxWidth, side],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setWidth((w) => Math.max(minWidth, w - KEYBOARD_STEP));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setWidth((w) => Math.min(maxWidth, w + KEYBOARD_STEP));
      }
    },
    [minWidth, maxWidth],
  );

  const toggleMaximize = useCallback(() => {
    setIsMaximized((v) => !v);
  }, []);

  // Escape to exit maximized
  useEffect(() => {
    if (!isMaximized) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsMaximized(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isMaximized]);

  const effectiveWidth = isMaximized ? "100%" : `${width}px`;

  /** Spread onto the handle element: makes it focusable and announces
   *  itself as a separator, plus pointer + keyboard resizing. */
  const handleProps = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-valuenow": Math.round(width),
    "aria-valuemin": minWidth,
    "aria-valuemax": maxWidth,
    "aria-label": storageKey
      ? `Resize panel (${storageKey})`
      : "Resize panel",
    tabIndex: 0,
    onPointerDown,
    onKeyDown,
  } as const;

  return {
    width,
    effectiveWidth,
    isMaximized,
    onMouseDown: onPointerDown,
    onPointerDown,
    onKeyDown,
    handleProps,
    toggleMaximize,
  };
}
