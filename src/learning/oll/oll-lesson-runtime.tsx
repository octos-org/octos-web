import { useEffect, useLayoutEffect, useRef } from "react";
import {
  mountInfiniteBoard,
  type MountedInfiniteBoard,
} from "octos-lesson-language/web-runtime";
import type { OllLessonRuntimeController } from "./use-oll-lesson-runtime";
import "octos-lesson-language/web-runtime/styles.css";

export function OllLessonBoard({
  runtime,
}: {
  runtime: OllLessonRuntimeController;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<MountedInfiniteBoard | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const mounted = mountInfiniteBoard(viewport);
    mountedRef.current = mounted;
    return () => {
      mountedRef.current = null;
      mounted.destroy();
    };
  }, []);

  useEffect(() => {
    mountedRef.current?.view.render(
      runtime.board,
      runtime.currentOperation,
    );
  }, [runtime.board, runtime.currentOperation, runtime.cursor]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => mountedRef.current?.view.fit());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={viewportRef}
      className="learning-oll-board"
      data-testid="oll-lesson-board"
      aria-label="OLL 无限白板"
    />
  );
}
