import { useState, useCallback, useEffect, useRef } from "react";

interface ResizablePanelOptions {
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  storageKey?: string;
  side?: "left" | "right";
}

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
  const activeDragCleanup = useRef<(() => void) | null>(null);

  // Persist width
  useEffect(() => {
    if (storageKey && !isMaximized) {
      localStorage.setItem(storageKey, String(width));
    }
  }, [width, storageKey, isMaximized]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      activeDragCleanup.current?.();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const delta =
          side === "right"
            ? startX.current - ev.clientX
            : ev.clientX - startX.current;
        const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta));
        setWidth(newWidth);
      };

      let finished = false;
      const finishDragging = () => {
        if (finished) return;
        finished = true;
        isDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", finishDragging);
        window.removeEventListener("blur", finishDragging);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        if (activeDragCleanup.current === finishDragging) {
          activeDragCleanup.current = null;
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", finishDragging);
      window.addEventListener("blur", finishDragging);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      activeDragCleanup.current = finishDragging;
    },
    [width, minWidth, maxWidth, side],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Some older PointerEvent shims omit isPrimary; only an explicit false
      // identifies an auxiliary pointer.
      if (e.isPrimary === false || e.button !== 0) return;
      e.preventDefault();
      activeDragCleanup.current?.();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      let finished = false;
      const finishDragging = () => {
        if (finished) return;
        finished = true;
        isDragging.current = false;
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", finishDragging);
        document.removeEventListener("pointercancel", finishDragging);
        window.removeEventListener("blur", finishDragging);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        if (activeDragCleanup.current === finishDragging) {
          activeDragCleanup.current = null;
        }
      };
      const onPointerMove = (ev: PointerEvent) => {
        if (!isDragging.current) return;
        const delta = side === "right"
          ? startX.current - ev.clientX
          : ev.clientX - startX.current;
        setWidth(Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta)));
      };

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", finishDragging);
      document.addEventListener("pointercancel", finishDragging);
      window.addEventListener("blur", finishDragging);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      activeDragCleanup.current = finishDragging;
    },
    [width, minWidth, maxWidth, side],
  );

  useEffect(() => () => {
    activeDragCleanup.current?.();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let next: number | null = null;
      if (e.key === "Home") next = minWidth;
      else if (e.key === "End") next = maxWidth;
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const physicalDelta = e.key === "ArrowRight" ? 16 : -16;
        const widthDelta = side === "left" ? physicalDelta : -physicalDelta;
        next = Math.min(maxWidth, Math.max(minWidth, width + widthDelta));
      }
      if (next === null) return;
      e.preventDefault();
      setWidth(next);
    },
    [maxWidth, minWidth, side, width],
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

  return {
    width,
    effectiveWidth,
    isMaximized,
    onMouseDown,
    onPointerDown,
    onKeyDown,
    toggleMaximize,
  };
}
