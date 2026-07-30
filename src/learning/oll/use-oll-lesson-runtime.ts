import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanonicalEvent, SemanticBoardState } from "octos-lesson-language";
import type {
  PlaybackAppendResult,
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
  waiting: boolean;
  board: SemanticBoardState | null;
  currentOperation?: PlaybackOperation;
  play(): void;
  pause(): void;
  restart(): void;
  nextBeat(): void;
  appendEvents(events: CanonicalEvent[]): PlaybackAppendResult;
}

interface OllLessonRuntimeOptions {
  source: string | null;
  storageKey: string;
  autoPlay?: boolean;
  incremental?: boolean;
  startAtEnd?: boolean;
}

function beatIds(operations: PlaybackOperation[]): string[] {
  return operations
    .filter((operation) => operation.type === "beat.end" && operation.beat_id)
    .map((operation) => operation.beat_id as string);
}

function advanceToAvailableEnd(session: BrowserLessonSession): void {
  session.pause();
  let remaining = session.operations.length + 1;
  while (
    remaining > 0 &&
    session.status !== "completed" &&
    session.status !== "waiting"
  ) {
    if (!session.advance()) break;
    remaining -= 1;
  }
}

export function useOllLessonRuntime({
  source,
  storageKey,
  autoPlay = false,
  incremental = false,
  startAtEnd = false,
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
            { incremental },
          )
        : null,
    [events, incremental, storageKey],
  );
  const [, setRevision] = useState(0);

  useEffect(() => {
    if (!session) return;
    const unsubscribe = session.subscribe(() => {
      setRevision((revision) => revision + 1);
    });
    if (startAtEnd) advanceToAvailableEnd(session);
    else if (autoPlay && session.status !== "completed") session.play();
    return () => {
      unsubscribe();
      session.pause();
    };
  }, [autoPlay, session, startAtEnd]);

  const play = useCallback(() => session?.play(), [session]);
  const pause = useCallback(() => session?.pause(), [session]);
  const restart = useCallback(() => {
    if (!session) return;
    session.reset();
    session.play();
  }, [session]);
  const nextBeat = useCallback(() => session?.advanceBeat(), [session]);
  const appendEvents = useCallback(
    (nextEvents: CanonicalEvent[]) => {
      if (!session) throw new Error("OLL Runtime 尚未初始化");
      const result = session.appendEvents(nextEvents);
      if (startAtEnd && result.accepted > 0) {
        advanceToAvailableEnd(session);
      }
      return result;
    },
    [session, startAtEnd],
  );

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
    waiting: projection.status === "waiting",
    board: projection.board,
    currentOperation: session.currentOperation,
    play,
    pause,
    restart,
    nextBeat,
    appendEvents,
  };
}
