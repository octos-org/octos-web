import { useCallback, useEffect, useMemo, useState } from "react";
import type { CanonicalEvent, SemanticBoardState } from "octos-lesson-language";
import type {
  PlaybackAppendResult,
  PlaybackOutlineStep,
  PlaybackOperation,
  PlaybackProjection,
  PlaybackStatus,
} from "octos-lesson-language/player";
import {
  BrowserLessonSession,
  LocalPlaybackStore,
  parseCanonicalJsonl,
} from "octos-lesson-language/web-runtime";

export interface OllLessonTopicDefinition {
  id: string;
  title: string;
  stepIds: string[];
}

export interface OllLessonOutlineTopic {
  id: string;
  title: string;
  steps: PlaybackOutlineStep[];
}

export interface OllLessonRuntimeController {
  title: string;
  language: string;
  status: PlaybackStatus;
  cursor: number;
  totalOperations: number;
  beatIndex: number;
  beatCount: number;
  outline: OllLessonOutlineTopic[];
  currentStepId?: string;
  currentBeatId?: string;
  attentionTargets: string[];
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
  viewStep(stepId: string): void;
  playStep(stepId: string): void;
  viewBeat(beatId: string): void;
  playBeat(beatId: string): void;
  completeNarration(beatId: string): void;
  appendEvents(events: CanonicalEvent[]): PlaybackAppendResult;
}

interface OllLessonRuntimeOptions {
  source: string | null;
  storageKey: string;
  autoPlay?: boolean;
  incremental?: boolean;
  narrationTiming?: "estimated" | "external";
  startAtEnd?: boolean;
  topics?: OllLessonTopicDefinition[];
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
  narrationTiming = "estimated",
  startAtEnd = false,
  topics = [],
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
            { incremental, narrationTiming },
          )
        : null,
    [events, incremental, narrationTiming, storageKey],
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
  const viewStep = useCallback(
    (stepId: string) => session?.seekToStep(stepId, "end"),
    [session],
  );
  const playStep = useCallback((stepId: string) => {
    if (!session) return;
    session.seekToStep(stepId, "start");
    session.play();
  }, [session]);
  const viewBeat = useCallback(
    (beatId: string) => session?.seekToBeat(beatId, "end"),
    [session],
  );
  const playBeat = useCallback((beatId: string) => {
    if (!session) return;
    session.seekToBeat(beatId, "start");
    session.play();
  }, [session]);
  const completeNarration = useCallback(
    (beatId: string) => session?.completeNarration(beatId),
    [session],
  );
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
  const currentBeatId =
    projection.current_beat_id ?? session.currentOperation?.beat_id;
  const currentBeatIndex = currentBeatId ? beats.indexOf(currentBeatId) : -1;
  const steps = session.outline;
  const currentStepId =
    projection.current_step_id ??
    session.currentOperation?.step_id ??
    (projection.cursor === 0 ? steps[0]?.id : steps.at(-1)?.id);
  const ungroupedSteps = new Set(steps.map((step) => step.id));
  const outline: OllLessonOutlineTopic[] = topics.flatMap((topic) => {
    const topicSteps = topic.stepIds.flatMap((stepId) => {
      const step = steps.find((candidate) => candidate.id === stepId);
      if (!step) return [];
      ungroupedSteps.delete(step.id);
      return [step];
    });
    return topicSteps.length > 0
      ? [{ id: topic.id, title: topic.title, steps: topicSteps }]
      : [];
  });
  const remainingSteps = steps.filter((step) => ungroupedSteps.has(step.id));
  if (remainingSteps.length > 0) {
    outline.push({
      id: events[0]?.lesson_id ?? "lesson",
      title: events[0]?.lesson?.title ?? "本节课程",
      steps: remainingSteps,
    });
  }

  return {
    title: events[0]?.lesson?.title ?? events[0]?.lesson_id ?? "OLL 课程",
    language: events[0]?.lesson?.language ?? "zh-CN",
    status: session.status,
    cursor: projection.cursor,
    totalOperations: projection.total_operations,
    beatIndex: currentBeatIndex,
    beatCount: beats.length,
    outline,
    currentStepId,
    currentBeatId,
    attentionTargets: session.attentionTargets,
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
    viewStep,
    playStep,
    viewBeat,
    playBeat,
    completeNarration,
    appendEvents,
  };
}
