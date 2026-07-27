import { useCallback, useEffect, useMemo, useState } from "react";
import type { SemanticBoardState } from "octos-lesson-language";
import type {
  PlaybackOperation,
  PlaybackProjection,
  PlaybackStatus,
} from "octos-lesson-language/player";
import {
  BrowserLessonSession,
  LocalPlaybackStore,
  parseCanonicalJsonl,
} from "octos-lesson-language/web-runtime";

export interface OllLessonRuntimeController {
  title: string;
  status: PlaybackStatus;
  cursor: number;
  totalOperations: number;
  beatIndex: number;
  beatCount: number;
  activeSpeech: string;
  playing: boolean;
  completed: boolean;
  board: SemanticBoardState | null;
  currentOperation?: PlaybackOperation;
  play(): void;
  pause(): void;
  restart(): void;
  nextBeat(): void;
}

interface OllLessonRuntimeOptions {
  source: string | null;
  storageKey: string;
  autoPlay?: boolean;
}

function beatIds(operations: PlaybackOperation[]): string[] {
  return operations
    .filter((operation) => operation.type === "beat.end" && operation.beat_id)
    .map((operation) => operation.beat_id as string);
}

export function useOllLessonRuntime({
  source,
  storageKey,
  autoPlay = false,
}: OllLessonRuntimeOptions): OllLessonRuntimeController | null {
  const events = useMemo(
    () => (source ? parseCanonicalJsonl(source) : null),
    [source],
  );
  const session = useMemo(
    () =>
      events
        ? new BrowserLessonSession(
            events,
            new LocalPlaybackStore(),
            storageKey,
          )
        : null,
    [events, storageKey],
  );
  const [, setRevision] = useState(0);

  useEffect(() => {
    if (!session) return;
    const unsubscribe = session.subscribe(() => {
      setRevision((revision) => revision + 1);
    });
    if (autoPlay && session.status !== "completed") session.play();
    return () => {
      unsubscribe();
      session.pause();
    };
  }, [autoPlay, session]);

  const play = useCallback(() => session?.play(), [session]);
  const pause = useCallback(() => session?.pause(), [session]);
  const restart = useCallback(() => {
    if (!session) return;
    session.reset();
    session.play();
  }, [session]);
  const nextBeat = useCallback(() => session?.advanceBeat(), [session]);

  if (!events || !session) return null;
  const projection: PlaybackProjection = session.projection;
  const beats = beatIds(session.operations);
  const currentBeatId = projection.current_beat_id;
  const currentBeatIndex = currentBeatId ? beats.indexOf(currentBeatId) : -1;

  return {
    title: events[0]?.lesson?.title ?? events[0]?.lesson_id ?? "OLL 课程",
    status: session.status,
    cursor: projection.cursor,
    totalOperations: projection.total_operations,
    beatIndex: currentBeatIndex,
    beatCount: beats.length,
    activeSpeech: projection.current_narration?.text ?? "",
    playing: session.isPlaying,
    completed: projection.status === "completed",
    board: projection.board,
    currentOperation: session.currentOperation,
    play,
    pause,
    restart,
    nextBeat,
  };
}
