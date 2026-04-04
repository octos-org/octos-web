import { useState, useCallback, useEffect, useRef } from "react";

interface ResizablePanelOptions {
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  storageKey?: string;
}

export function useResizablePanel({
  minWidth = 280,
  maxWidth = 900,
  defaultWidth = 360,
  storageKey = "octos_panel_width",
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

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        // Panel is on the right, so dragging left = wider
        const delta = startX.current - ev.clientX;
        const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta));
        setWidth(newWidth);
      };

      const onMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, minWidth, maxWidth],
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

  return { width, effectiveWidth, isMaximized, onMouseDown, toggleMaximize };
}
