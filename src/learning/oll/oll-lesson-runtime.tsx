import { useEffect, useLayoutEffect, useRef } from "react";
import {
  mountInfiniteBoard,
  type MountedInfiniteBoard,
  type ViewportInsets,
} from "octos-lesson-language/web-runtime";
import type { OllLessonRuntimeController } from "./use-oll-lesson-runtime";
import "octos-lesson-language/web-runtime/styles.css";

function learningBoardInsets(viewport: HTMLElement): ViewportInsets {
  const compact = viewport.clientWidth <= 900;
  return {
    top: compact ? 78 : 92,
    right: compact ? 18 : 28,
    bottom: compact ? 180 : 190,
    left: compact ? 18 : 28,
  };
}

export function OllLessonBoard({
  runtime,
}: {
  runtime: OllLessonRuntimeController;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<MountedInfiniteBoard | null>(null);
  const renderedFocusRef = useRef<string[]>([]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const mounted = mountInfiniteBoard(viewport);
    mountedRef.current = mounted;
    try {
      mounted.view.setViewportInsets(learningBoardInsets(viewport));
    } catch (cause) {
      mountedRef.current = null;
      mounted.destroy();
      throw cause;
    }
    return () => {
      mountedRef.current = null;
      mounted.destroy();
    };
  }, []);

  useEffect(() => {
    const view = mountedRef.current?.view;
    const boardFocus = runtime.board?.focus ?? [];
    const renderedFocus = renderedFocusRef.current;
    const focusChanged =
      boardFocus.length !== renderedFocus.length ||
      boardFocus.some((target, index) => target !== renderedFocus[index]);
    const atPlaybackBoundary =
      runtime.currentOperation?.type === "beat.end" ||
      runtime.currentOperation?.type === "step.commit";
    view?.render(
      runtime.board,
      runtime.currentOperation,
    );
    if (runtime.attentionTargets.length > 0) {
      view?.focusTargets(runtime.attentionTargets);
    } else if (atPlaybackBoundary && focusChanged) {
      // React can batch every operation produced by advanceBeat() into the
      // boundary render. In that case the board already contains the new Beat
      // focus, but the view never observed the intermediate board.focus frame.
      view?.focusTargets(boardFocus);
    }
    renderedFocusRef.current = [...boardFocus];
  }, [
    runtime.attentionTargets,
    runtime.board,
    runtime.currentOperation,
    runtime.cursor,
  ]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const mounted = mountedRef.current;
      if (mounted) {
        mounted.view.setViewportInsets(learningBoardInsets(viewport));
      }
    });
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
