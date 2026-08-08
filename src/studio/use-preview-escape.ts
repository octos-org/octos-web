import { useCallback, useEffect, useRef } from "react";

const previewStack: symbol[] = [];

function activatePreview(id: symbol): void {
  const existing = previewStack.indexOf(id);
  if (existing !== -1) previewStack.splice(existing, 1);
  previewStack.push(id);
}

function removePreview(id: symbol): void {
  const existing = previewStack.indexOf(id);
  if (existing !== -1) previewStack.splice(existing, 1);
}

export function usePreviewEscape(onBack: () => void) {
  const id = useRef(Symbol("studio-preview"));
  const onBackRef = useRef(onBack);
  const activate = useCallback(() => activatePreview(id.current), []);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    const previewId = id.current;
    activate();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (previewStack[previewStack.length - 1] !== previewId) return;
      onBackRef.current();
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      removePreview(previewId);
    };
  }, [activate]);

  return { activate };
}
