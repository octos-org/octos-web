import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalEvent } from "octos-lesson-language";
import { compilePlaybackOperations } from "octos-lesson-language/player";
import { parseCanonicalJsonl } from "octos-lesson-language/web-runtime";
import {
  Camera,
  CameraOff,
  ChevronRight,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { uploadFiles } from "@/api/chat";
import { getSessionFiles } from "@/api/sessions";
import {
  invokeSkillAction,
  listSkillActionJobs,
  type SkillActionJob,
} from "@/api/skill-actions";
import { sendMessage } from "@/runtime/ui-protocol-send";
import { unlockAudio } from "@/home/voice/audio-playback";
import { CameraPreview } from "@/home/voice/camera-preview";
import {
  DEFAULT_CAMERA_FRAME_SETTINGS,
} from "@/home/voice/use-camera-frame";
import {
  useVoiceConversation,
  type VoiceConversationOptions,
  type VoiceConversationTurn,
} from "@/home/voice/use-voice-conversation";
import { useOminixRuntimeSummary } from "@/home/use-ominix-runtime-summary";
import { useRenderThreads } from "@/store/projection-render-adapter";
import type { Thread } from "@/store/thread-store";
import { CameraSettingsDialog } from "./camera-settings-dialog";
import type { LearningBoardContext } from "./board/session-board";
import geometryLessonSource from "./oll/fixtures/geometry-auxiliary-line-v2.canonical.jsonl?raw";
import unitCircleSineLessonSource from "./oll/fixtures/unit-circle-sine.canonical.jsonl?raw";
import { OllCourseOutline } from "./oll/oll-course-outline";
import {
  LearningWhiteboard,
  type DegradedVisualRetryRequest,
} from "./oll/oll-lesson-runtime";
import type { InkSelectionSnapshot } from "octos-lesson-language/ink-runtime";
import {
  buildDegradedVisualRetryContext,
  buildDegradedVisualRetryPrompt,
} from "./degraded-visual-retry";
import { isLessonDeliverySettled } from "./oll/lesson-delivery";
import { useOllNarrationTts } from "./oll/use-oll-narration-tts";
import {
  buildOllLessonTopics,
  courseReplayStartStep,
  collectOllLessonArtifacts,
  collectPersistedOllLessonArtifacts,
  composeOllClassroomEvents,
  loadOllLessonArtifact,
  mergeOllLessonArtifacts,
  ollArtifactIdentity,
} from "./oll/oll-artifacts";
import {
  ollPlaybackStorageKey,
  type OllFixture,
} from "./oll/oll-playback-storage";
import { useOllLessonRuntime } from "./oll/use-oll-lesson-runtime";
import {
  addSelectionSource,
  buildSelectionClassificationActionArguments,
  buildSelectionEnhancementActionArguments,
  buildSelectionEnhancementTurnContext,
  collectPersistedSelectionEnhancementArtifacts,
  collectSelectionEnhancementArtifacts,
  hideSelectionEnhancement,
  removeSelectionSources,
  loadSelectionEnhancementArtifact,
  loadSelectionEnhancementState,
  mergeSelectionEnhancementArtifacts,
  parseSelectionClassificationMetadata,
  saveSelectionEnhancementState,
  selectionArtifactMatchesSource,
  selectionBoardContextTargetsExist,
  type SelectionBoardContext,
  type SelectionClassification,
  type SelectionContentKind,
  type SelectionEnhancementArtifact,
  type SelectionEnhancementState,
} from "./selection-enhancements";
import type { SelectionToolId } from "./selection-tools";
import { isCurrentInkMergeCompletion } from "./ink-replay";
import { OctosTeacher } from "./octos-teacher";
import { StudentInputDock } from "./student-input-dock";
import type { WhiteboardLoadingState } from "./whiteboard-loading-block";
import {
  buildComposerBoardReferenceContext,
  type ComposerBoardReference,
} from "./composer-board-references";
import {
  loadWhiteboardQuestions,
  saveWhiteboardQuestions,
  type WhiteboardQuestionRecord,
  type WhiteboardQuestionStatus,
} from "./whiteboard-questions";
import {
  COURSE_PENDING_FOOTPRINT_HEIGHT,
  COURSE_PENDING_FOOTPRINT_WIDTH,
  createCourseRegion,
  expandCourseRegionBounds,
  loadCourseRegions,
  saveCourseRegions,
  type CourseRegionRecord,
} from "./course-regions";
import "./learning-workspace.css";

const geometryLessonEvents = parseCanonicalJsonl(geometryLessonSource);
const unitCircleSineLessonEvents = parseCanonicalJsonl(unitCircleSineLessonSource);

const ollFixtureEvents: Record<OllFixture, CanonicalEvent[]> = {
  "geometry-v2": geometryLessonEvents,
  "unit-circle-sine": unitCircleSineLessonEvents,
};

const DELIVERABLE_ARTIFACT_SUFFIXES = [
  ".octos-lesson.json",
  ".octos-selection-enhancement.json",
] as const;

interface PendingLessonJobRecord {
  jobId: string;
  turnId: string;
  referenceIds: string[];
}

function pendingLessonJobsStorageKey(sessionId: string): string {
  return `octos-learning-lesson-jobs:v1:${sessionId}`;
}

function loadPendingLessonJobs(sessionId: string): Map<string, PendingLessonJobRecord> {
  try {
    if (typeof window === "undefined") return new Map();
    const raw = window.localStorage.getItem(pendingLessonJobsStorageKey(sessionId));
    if (!raw) return new Map();
    const records = JSON.parse(raw) as unknown;
    if (!Array.isArray(records)) return new Map();
    return new Map(records.flatMap((candidate) => {
      if (
        !candidate
        || typeof candidate !== "object"
        || typeof candidate.jobId !== "string"
        || typeof candidate.turnId !== "string"
        || !Array.isArray(candidate.referenceIds)
      ) return [];
      return [[candidate.jobId, candidate as PendingLessonJobRecord]];
    }));
  } catch {
    return new Map();
  }
}

function savePendingLessonJobs(
  sessionId: string,
  jobs: ReadonlyMap<string, PendingLessonJobRecord>,
): void {
  try {
    if (typeof window === "undefined") return;
    if (jobs.size === 0) {
      window.localStorage.removeItem(pendingLessonJobsStorageKey(sessionId));
      return;
    }
    window.localStorage.setItem(
      pendingLessonJobsStorageKey(sessionId),
      JSON.stringify([...jobs.values()]),
    );
  } catch {
    // The current page still tracks the job when browser storage is unavailable.
  }
}

function lessonJobError(job: SkillActionJob): string {
  const detail = `${job.error ?? ""} ${job.output ?? ""}`.trim();
  if (/\b429\b|resource exhausted|rate.?limit|quota/iu.test(detail)) {
    return "课程生成服务当前比较繁忙，请稍后再试。";
  }
  if (/timeout|timed out|超时/iu.test(detail)) {
    return "课程生成超时，请稍后再试。";
  }
  return detail || "课程生成失败，请重试。";
}

function lessonJobNonLessonResponse(job: SkillActionJob): {
  disposition: "clarify" | "ignore";
  learnerResponse: string;
} | null {
  if (!job.result || typeof job.result !== "object" || Array.isArray(job.result)) {
    return null;
  }
  const result = job.result as Record<string, unknown>;
  const metadata = result.structured_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const disposition = record.lesson_disposition;
  if (disposition !== "clarify" && disposition !== "ignore") return null;
  return {
    disposition,
    learnerResponse: typeof record.learner_response === "string"
      ? record.learner_response.trim()
      : "",
  };
}

function threadHasDeliverableArtifact(
  threads: Thread[],
  turnId: string,
): boolean {
  const thread = threads.find(
    (candidate) => candidate.id === turnId || candidate.turnId === turnId,
  );
  if (!thread) return false;
  return [
    ...thread.responses,
    ...(thread.pendingAssistant ? [thread.pendingAssistant] : []),
  ].some((message) => message.files.some((file) => {
    const path = file.path.toLowerCase();
    return DELIVERABLE_ARTIFACT_SUFFIXES.some((suffix) => path.endsWith(suffix));
  }));
}

export interface LearningWorkspaceProps {
  sessionId: string;
  playbackMode?: "live" | "review";
  voiceEnabled?: boolean;
  onUseTextMode?: () => void;
  onUseVoiceMode?: () => Promise<void> | void;
  onLearnerInput?: (text: string) => void;
  onWhiteboardActivity?: () => void;
  initialAudio?: Blob | null;
  conversationOptions?: VoiceConversationOptions;
  onTurnsChange?: (turns: VoiceConversationTurn[]) => void;
  onBoardContextChange?: (context: LearningBoardContext) => void;
  onBack: () => void;
  onVoiceExit?: () => void;
  ollFixture?: OllFixture;
}

function inkPlaybackRunStorageKey(sessionId: string): string {
  return `octos-learning-ink-run:v1:${sessionId}`;
}

function inkMergeSourceStorageKey(sessionId: string): string {
  return `octos-learning-ink-merge-source:v1:${sessionId}`;
}

function cumulativeInkRunStorageKey(sessionId: string): string {
  return `octos-learning-ink-cumulative-run:v1:${sessionId}`;
}

function inkDocumentSessionId(sessionId: string, run: number): string {
  return run === 0 ? sessionId : `${sessionId}:replay:${run}`;
}

function readInkPlaybackRun(sessionId: string): number {
  try {
    if (typeof window === "undefined") return 0;
    const parsed = Number(
      window.localStorage.getItem(inkPlaybackRunStorageKey(sessionId)),
    );
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function readInkMergeSourceSessionId(
  sessionId: string,
  currentRun: number,
): string | null {
  try {
    if (typeof window === "undefined") return null;
    const source = window.localStorage.getItem(
      inkMergeSourceStorageKey(sessionId),
    );
    if (source === sessionId || source?.startsWith(`${sessionId}:replay:`)) {
      return source;
    }
    const cumulativeRun = Number(
      window.localStorage.getItem(cumulativeInkRunStorageKey(sessionId)),
    );
    // Versions before cumulative replay restoration created a new document
    // but never recorded its parent. Recover the original session document
    // once, then mark this run cumulative after the merge succeeds.
    if (
      currentRun > 0 &&
      (!Number.isSafeInteger(cumulativeRun) || cumulativeRun !== currentRun)
    ) {
      return sessionId;
    }
    return null;
  } catch {
    return null;
  }
}

export function LearningWorkspace({
  sessionId,
  playbackMode = "live",
  voiceEnabled = true,
  onUseTextMode,
  onUseVoiceMode,
  onLearnerInput,
  onWhiteboardActivity,
  initialAudio,
  conversationOptions,
  onTurnsChange,
  onBoardContextChange,
  onBack,
  onVoiceExit,
  ollFixture,
}: LearningWorkspaceProps) {
  const runtime = useOminixRuntimeSummary();
  const threads = useRenderThreads(sessionId);
  const [narrationSpeechActive, setNarrationSpeechActive] = useState(false);
  // Declared early: `externalSpeechActive` (below) consults it to decide
  // whether muted narration still owns the microphone (issue #315).
  const [narrationAudioEnabled, setNarrationAudioEnabled] = useState(true);
  const [completedTurnId, setCompletedTurnId] = useState<string | null>(null);
  const [plainReply, setPlainReply] = useState<{
    turnId: string;
    text: string;
  } | null>(null);
  const [plainReplySpoken, setPlainReplySpoken] = useState(false);
  const [pausedLessonSource, setPausedLessonSource] = useState<string | null>(null);
  const [inkPlaybackRun, setInkPlaybackRun] = useState(
    () => readInkPlaybackRun(sessionId),
  );
  const [inkMergeSourceSessionId, setInkMergeSourceSessionId] = useState(
    () => readInkMergeSourceSessionId(sessionId, readInkPlaybackRun(sessionId)),
  );
  const [playbackCourseTarget, setPlaybackCourseTarget] = useState<{
    courseId: string;
    sequence: number;
  } | null>(null);
  const inkSessionId = inkDocumentSessionId(sessionId, inkPlaybackRun);
  const replayingWithoutStudentAdditions = inkMergeSourceSessionId !== null;
  const [loadedOllArtifacts, setLoadedOllArtifacts] = useState<
    Record<string, CanonicalEvent[]>
  >({});
  const [persistedOllArtifacts, setPersistedOllArtifacts] = useState<
    ReturnType<typeof collectPersistedOllLessonArtifacts>
  >([]);
  const [ollGenerationSessionId, setOllGenerationSessionId] = useState<
    string | null
  >(null);
  const pendingLessonJobsRef = useRef(loadPendingLessonJobs(sessionId));
  const [rejectedOllArtifactIds, setRejectedOllArtifactIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [selectionState, setSelectionState] =
    useState<SelectionEnhancementState | null>(null);
  const [persistedSelectionArtifacts, setPersistedSelectionArtifacts] =
    useState<ReturnType<typeof collectPersistedSelectionEnhancementArtifacts>>([]);
  const [loadedSelectionArtifacts, setLoadedSelectionArtifacts] = useState<
    Record<string, SelectionEnhancementArtifact>
  >({});
  const selectionStateRef = useRef<SelectionEnhancementState | null>(null);
  const selectionArtifacts = useMemo(
    () => mergeSelectionEnhancementArtifacts(
      persistedSelectionArtifacts,
      collectSelectionEnhancementArtifacts(threads),
    ),
    [persistedSelectionArtifacts, threads],
  );
  const requestedSelectionArtifactsRef = useRef(new Set<string>());
  const selectionArtifactRequestsRef = useRef(
    new Map<string, AbortController>(),
  );
  const pendingVoiceSelectionRef = useRef<{
    snapshot: InkSelectionSnapshot;
    contentKind: SelectionContentKind;
    boardContext: SelectionBoardContext;
    file: File;
    claimed: boolean;
  } | null>(null);
  const voiceQuestionSourcesRef = useRef(new Map<string, {
    sourceId: string;
    bounds: InkSelectionSnapshot["bounds"];
  } | null>());
  const completedQuestionTurnIdsRef = useRef(new Set<string>());
  const failedQuestionErrorsRef = useRef(new Map<string, string>());
  const [composerBoardReferences, setComposerBoardReferences] =
    useState<ComposerBoardReference[]>([]);
  const [whiteboardQuestions, setWhiteboardQuestions] = useState<
    WhiteboardQuestionRecord[]
  >(() => loadWhiteboardQuestions(sessionId));
  const [courseRegions, setCourseRegions] = useState<CourseRegionRecord[]>(
    () => loadCourseRegions(sessionId),
  );
  useEffect(() => {
    saveWhiteboardQuestions(sessionId, whiteboardQuestions);
  }, [sessionId, whiteboardQuestions]);
  useEffect(() => {
    saveCourseRegions(sessionId, courseRegions);
  }, [courseRegions, sessionId]);
  const addWhiteboardQuestion = useCallback((
    question: WhiteboardQuestionRecord,
  ) => {
    setWhiteboardQuestions((current) => {
      const next = [
        ...current.filter((candidate) => candidate.id !== question.id),
        question,
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return next;
    });
  }, []);
  const updateWhiteboardQuestion = useCallback((
    questionId: string,
    patch: Partial<Pick<
      WhiteboardQuestionRecord,
      "text" | "position" | "status" | "error"
    >>,
  ) => {
    setWhiteboardQuestions((current) => {
      let changed = false;
      const next = current.map((question) => {
        if (question.id !== questionId) return question;
        const updated = { ...question, ...patch };
        if (
          updated.text === question.text
          && updated.status === question.status
          && updated.error === question.error
          && updated.position?.x === question.position?.x
          && updated.position?.y === question.position?.y
        ) return question;
        changed = true;
        return updated;
      });
      if (!changed) return current;
      return next;
    });
  }, []);
  const setWhiteboardQuestionStatus = useCallback((
    questionId: string,
    status: WhiteboardQuestionStatus,
  ) => updateWhiteboardQuestion(questionId, { status }), [
    updateWhiteboardQuestion,
  ]);
  const discardWhiteboardQuestion = useCallback((questionId: string) => {
    setWhiteboardQuestions((current) => current.filter(
      (question) => question.id !== questionId,
    ));
    setCourseRegions((current) => current.filter(
      (region) => region.questionId !== questionId,
    ));
  }, []);
  const registerVoiceQuestion = useCallback((
    questionId: string,
    text: string,
    source: {
      sourceId: string;
      bounds: InkSelectionSnapshot["bounds"];
    } | null,
  ) => {
    setWhiteboardQuestions((current) => {
      const existing = current.find((question) => question.id === questionId);
      if (existing) {
        if (existing.text === text) return current;
        return current.map((question) => question.id === questionId
          ? { ...question, text }
          : question);
      }
      const failedError = failedQuestionErrorsRef.current.get(questionId);
      return [...current, {
        id: questionId,
        sessionId,
        text,
        origin: source ? "selection" as const : "composer" as const,
        createdAt: new Date().toISOString(),
        status: failedError
          ? "failed" as const
          : completedQuestionTurnIdsRef.current.has(questionId)
            ? "answered" as const
            : "pending" as const,
        ...(failedError ? { error: failedError } : {}),
        ...(source ? { source } : {}),
      }].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    });
  }, [sessionId]);
  const placeWhiteboardQuestion = useCallback((
    questionId: string,
    position: { x: number; y: number },
  ) => {
    updateWhiteboardQuestion(questionId, { position });
    const question = whiteboardQuestions.find((candidate) =>
      candidate.id === questionId && candidate.origin === "composer");
    if (!question) return;
    setCourseRegions((current) => {
      const existing = current.find((region) => region.questionId === questionId);
      if (!existing) {
        return [...current, createCourseRegion(
          sessionId,
          questionId,
          position,
          {
            width: COURSE_PENDING_FOOTPRINT_WIDTH,
            height: COURSE_PENDING_FOOTPRINT_HEIGHT,
          },
          question.createdAt,
        )].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      }
      if (existing.origin.x === position.x && existing.origin.y === position.y) {
        return current;
      }
      const offsetX = position.x - existing.origin.x;
      const offsetY = position.y - existing.origin.y;
      return current.map((region) => region.id === existing.id ? {
        ...region,
        origin: { ...position },
        bounds: {
          ...region.bounds,
          x: region.bounds.x + offsetX,
          y: region.bounds.y + offsetY,
        },
      } : region);
    });
  }, [
    sessionId,
    updateWhiteboardQuestion,
    whiteboardQuestions,
  ]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setCourseRegions((current) => {
        const knownQuestionIds = new Set(
          current.map((region) => region.questionId),
        );
        const missing = whiteboardQuestions.flatMap((question) => {
          if (
            question.origin !== "composer"
            || !question.position
            || knownQuestionIds.has(question.id)
          ) return [];
          knownQuestionIds.add(question.id);
          return [createCourseRegion(
            sessionId,
            question.id,
            question.position,
            {
              width: COURSE_PENDING_FOOTPRINT_WIDTH,
              height: COURSE_PENDING_FOOTPRINT_HEIGHT,
            },
            question.createdAt,
          )];
        });
        if (missing.length === 0) return current;
        return [...current, ...missing].sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt));
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sessionId, whiteboardQuestions]);
  const updateCourseRegion = useCallback((
    regionId: string,
    patch: Partial<Pick<
      CourseRegionRecord,
      "runtimeRegionId" | "bounds" | "reservedWidth"
    >>,
  ) => {
    setCourseRegions((current) => current.map((region) => {
      if (region.id !== regionId) return region;
      const updated = {
        ...region,
        ...patch,
        ...(patch.bounds ? {
          bounds: expandCourseRegionBounds(region.bounds, patch.bounds),
        } : {}),
      };
      return JSON.stringify(updated) === JSON.stringify(region)
        ? region
        : updated;
    }));
  }, []);
  const visibleSelectionEnhancements = useMemo(() => {
    const hidden = new Set(selectionState?.hidden_enhancement_turn_ids ?? []);
    return selectionArtifacts.flatMap((artifact) => {
      const loaded = loadedSelectionArtifacts[artifact.path];
      const source = selectionState?.sources.find(
        (candidate) => candidate.source_id === loaded?.source.source_id,
      );
      return loaded
        && !hidden.has(loaded.turn_id)
        && (!source || selectionArtifactMatchesSource(loaded, source))
        ? [loaded]
        : [];
    });
  }, [loadedSelectionArtifacts, selectionArtifacts, selectionState]);
  const ollArtifacts = useMemo(
    () => mergeOllLessonArtifacts(
      persistedOllArtifacts,
      collectOllLessonArtifacts(threads),
    ),
    [persistedOllArtifacts, threads],
  );
  const requestedOllArtifactsRef = useRef(new Set<string>());
  const ollArtifactRequestsRef = useRef(new Map<string, AbortController>());
  const deliveredOllLessons = useMemo(() => {
    const lessons: CanonicalEvent[][] = [];
    for (const artifact of ollArtifacts) {
      const artifactIdentity = ollArtifactIdentity(artifact);
      const events = loadedOllArtifacts[artifactIdentity];
      if (rejectedOllArtifactIds.has(artifactIdentity)) continue;
      if (!events) break;
      lessons.push(events);
    }
    return lessons;
  }, [loadedOllArtifacts, ollArtifacts, rejectedOllArtifactIds]);
  const deliveredOllEvents = useMemo(() => {
    const events = composeOllClassroomEvents(deliveredOllLessons, sessionId);
    return events.length > 0 ? events : null;
  }, [deliveredOllLessons, sessionId]);
  const deliveredOllQuestionIds = useMemo(
    () => deliveredOllLessons.map((events) => {
      const artifact = ollArtifacts.find((candidate) =>
        loadedOllArtifacts[ollArtifactIdentity(candidate)] === events);
      return artifact?.turnId;
    }),
    [deliveredOllLessons, loadedOllArtifacts, ollArtifacts],
  );
  const activeOllEvents = ollFixture
    ? ollFixtureEvents[ollFixture]
    : deliveredOllEvents;
  const appendedOllEventCountRef = useRef(1);
  const expectedOllOperationCount = useMemo(
    () => activeOllEvents
      ? compilePlaybackOperations(activeOllEvents, { allowIncomplete: true }).length
      : 0,
    [activeOllEvents],
  );
  const activeOllTopics = useMemo(
    () => buildOllLessonTopics(
      ollFixture
        ? [ollFixtureEvents[ollFixture]]
        : deliveredOllLessons,
      ollFixture ? [] : deliveredOllQuestionIds,
    ),
    [deliveredOllLessons, deliveredOllQuestionIds, ollFixture],
  );
  const ollOpenSource = activeOllEvents?.[0]
    ? JSON.stringify(activeOllEvents[0])
    : null;
  const ollLesson = useOllLessonRuntime({
    source: ollOpenSource,
    storageKey: ollPlaybackStorageKey(sessionId, ollFixture),
    autoPlay: Boolean(activeOllEvents) && playbackMode === "live",
    incremental: Boolean(activeOllEvents),
    narrationTiming: "external",
    startAtEnd: Boolean(activeOllEvents) && playbackMode === "review",
    topics: activeOllTopics,
    deliveredProgram: activeOllEvents,
  });
  // Audio ownership follows playback intent, not the current speech sample.
  // A live lesson claims the microphone on its first render and keeps it
  // through Beat/event gaps, then releases it once the Runtime has consumed
  // every operation compiled from the currently delivered Canonical events.
  const hasUndeliveredOllEvents = Boolean(
    ollLesson &&
    (
      ollLesson.totalOperations < expectedOllOperationCount ||
      ollGenerationSessionId === sessionId
    ),
  );
  const deliveryReachedCurrentEnd = Boolean(
    ollLesson &&
    isLessonDeliverySettled(ollLesson, hasUndeliveredOllEvents),
  );
  const lessonDeliverySettled = Boolean(ollLesson?.deliverySettled);
  const setOllDeliverySettled = ollLesson?.setDeliverySettled;
  useEffect(() => {
    if (hasUndeliveredOllEvents) setOllDeliverySettled?.(false);
    else if (deliveryReachedCurrentEnd) setOllDeliverySettled?.(true);
  }, [
    deliveryReachedCurrentEnd,
    hasUndeliveredOllEvents,
    setOllDeliverySettled,
  ]);
  const lessonOwnsNarration =
    ollLesson !== null &&
    (playbackMode === "live" || ollLesson.playing) &&
    !lessonDeliverySettled &&
    pausedLessonSource !== ollOpenSource;
  const [textTurnPending, setTextTurnPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const handleTurnComplete = useCallback((turnId: string) => {
    pendingVoiceSelectionRef.current = null;
    const thread = threads.find((candidate) => candidate.id === turnId);
    const questionId = thread?.turnId ?? turnId;
    completedQuestionTurnIdsRef.current.add(turnId);
    completedQuestionTurnIdsRef.current.add(questionId);
    setWhiteboardQuestionStatus(questionId, "answered");
    setPlainReply(null);
    setPlainReplySpoken(false);
    setCompletedTurnId(turnId);
    conversationOptions?.onTurnComplete?.(turnId);
  }, [conversationOptions, setWhiteboardQuestionStatus, threads]);
  const startDirectLessonGeneration = useCallback(async (
    turnId: string,
    learnerRequest: string,
    inputModality: "text" | "voice" = "text",
  ) => {
    setTextTurnPending(true);
    try {
      const invocation = await invokeSkillAction(
        sessionId,
        "learning.lesson.generate",
        {
          turn_id: turnId,
          learner_request: learnerRequest,
          request_source: "self_contained",
          language: "zh-CN",
          input_modality: inputModality,
        },
      );
      const failedResult = (invocation.results ?? [])
        .find((result) => !result.success);
      if (!invocation.ok || failedResult) {
        throw new Error(
          failedResult?.output?.trim() || "课程生成任务启动失败，请重试",
        );
      }
      const jobs = invocation.jobs ?? [];
      if (jobs.length === 0) {
        await getSessionFiles(sessionId).then((files) => {
          setPersistedOllArtifacts(collectPersistedOllLessonArtifacts(files));
        });
        setWhiteboardQuestionStatus(turnId, "answered");
        handleTurnComplete(turnId);
        return;
      }
      jobs.forEach((job) => {
        pendingLessonJobsRef.current.set(job.job_id, {
          jobId: job.job_id,
          turnId,
          referenceIds: [],
        });
      });
      savePendingLessonJobs(sessionId, pendingLessonJobsRef.current);
      setOllGenerationSessionId(sessionId);
    } finally {
      setTextTurnPending(false);
    }
  }, [handleTurnComplete, sessionId, setWhiteboardQuestionStatus]);
  const handleVoiceTurnError = useCallback((turnId: string, error: Error) => {
    const message = error.message.trim() || "课程生成失败，请稍后再试";
    const thread = threads.find((candidate) => candidate.id === turnId);
    const questionId = thread?.turnId ?? turnId;
    failedQuestionErrorsRef.current.set(turnId, message);
    failedQuestionErrorsRef.current.set(questionId, message);
    updateWhiteboardQuestion(questionId, { status: "failed", error: message });
    setTextTurnPending(false);
    setCompletedTurnId(null);
    setPlainReply({ turnId: questionId, text: message });
    setPlainReplySpoken(false);
    setSendError(message);
    conversationOptions?.onTurnError?.(turnId, error);
  }, [conversationOptions, threads, updateWhiteboardQuestion]);
  const voiceConversationOptions = useMemo<VoiceConversationOptions>(
    () => ({
      ...conversationOptions,
      onTurnStart: (turnId: string) => {
        const pendingSelection = pendingVoiceSelectionRef.current;
        voiceQuestionSourcesRef.current.set(turnId, pendingSelection ? {
          sourceId: pendingSelection.snapshot.source_id,
          bounds: { ...pendingSelection.snapshot.bounds },
        } : null);
        conversationOptions?.onTurnStart?.(turnId);
      },
      getAdditionalTurnFiles: async () => {
        const pending = pendingVoiceSelectionRef.current;
        if (!pending || pending.claimed) return [];
        pending.claimed = true;
        return [pending.file];
      },
      buildTurnText: (
        context: Parameters<
          NonNullable<VoiceConversationOptions["buildTurnText"]>
        >[0],
      ) => {
        const base = conversationOptions?.buildTurnText?.(context) ?? "";
        const pending = pendingVoiceSelectionRef.current;
        const selectionPath = context.additionalMediaPaths?.[0];
        if (!pending || !selectionPath) return base;
        const selectionContext = [
          base,
          buildSelectionEnhancementTurnContext({
            sessionId,
            turnId: context.turnId,
            mediaPath: selectionPath,
            source: pending.snapshot,
            contentKind: pending.contentKind,
            lessonTitle: ollLesson?.title,
            boardSummary: ollLesson
              ? `${ollLesson.title}；进度 ${ollLesson.cursor}/${ollLesson.totalOperations}`
              : undefined,
            boardContext: pending.boardContext,
            toolId: "custom-question",
          }),
        ].filter(Boolean).join("\n");
        pendingVoiceSelectionRef.current = null;
        return selectionContext;
      },
      // Muted narration does NOT own the mic: with the narration silenced
      // there is nothing external to protect, so the student can barge in
      // naturally (issue #315).
      externalSpeechActive:
        voiceEnabled &&
        ((lessonOwnsNarration && narrationAudioEnabled) ||
          narrationSpeechActive ||
          textTurnPending),
      // Do not feed the final speaker frame / acoustic echo back into ASR when
      // a lesson or plain spoken reply releases the microphone.
      externalSpeechReleaseDelayMs: 1200,
      onAdmittedSpeech: async (context) => {
        if (
          context.currentFramePath
          || (context.additionalMediaPaths?.length ?? 0) > 0
        ) return false;
        registerVoiceQuestion(context.turnId, context.transcript, null);
        onLearnerInput?.(context.transcript);
        await startDirectLessonGeneration(
          context.turnId,
          context.transcript,
          "voice",
        );
        return true;
      },
      onTurnError: handleVoiceTurnError,
      onTurnComplete: handleTurnComplete,
    }),
    [
      conversationOptions,
      handleTurnComplete,
      handleVoiceTurnError,
      lessonOwnsNarration,
      narrationAudioEnabled,
      narrationSpeechActive,
      ollLesson,
      onLearnerInput,
      registerVoiceQuestion,
      sessionId,
      startDirectLessonGeneration,
      textTurnPending,
      voiceEnabled,
    ],
  );
  const conv = useVoiceConversation(
    sessionId,
    undefined,
    onVoiceExit ?? onBack,
    voiceConversationOptions,
  );
  const beginFreshInkPlayback = useCallback(() => {
    const next = Number.isSafeInteger(inkPlaybackRun + 1)
      ? inkPlaybackRun + 1
      : 1;
    setInkPlaybackRun(next);
    setInkMergeSourceSessionId(inkSessionId);
    try {
      window.localStorage.setItem(
        inkPlaybackRunStorageKey(sessionId),
        String(next),
      );
      window.localStorage.setItem(
        inkMergeSourceStorageKey(sessionId),
        inkSessionId,
      );
    } catch {
      // The new in-memory run still keeps replay clean when storage is unavailable.
    }
  }, [inkPlaybackRun, inkSessionId, sessionId]);
  const markPlaybackCourse = useCallback((stepId?: string) => {
    const topic = (stepId
      ? activeOllTopics.find((candidate) => candidate.stepIds.includes(stepId))
      : activeOllTopics.find((candidate) =>
          candidate.stepIds.includes(ollLesson?.currentStepId ?? "")))
      ?? activeOllTopics.at(-1);
    if (!topic) return;
    const courseId = topic.questionId ?? topic.id;
    setPlaybackCourseTarget((current) => ({
      courseId,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }, [activeOllTopics, ollLesson?.currentStepId]);
  const markPlaybackBeatCourse = useCallback((beatId: string) => {
    const step = ollLesson?.outline
      .flatMap((topic) => topic.steps)
      .find((candidate) => candidate.beats.some((beat) => beat.id === beatId));
    markPlaybackCourse(step?.id);
  }, [markPlaybackCourse, ollLesson?.outline]);
  const controlledOllLesson = useMemo(() => {
    if (!ollLesson) return null;
    const claim = () => setPausedLessonSource(null);
    const release = () => setPausedLessonSource(ollOpenSource);
    return {
      ...ollLesson,
      play: () => {
        claim();
        ollLesson.play();
      },
      pause: () => {
        release();
        ollLesson.pause();
      },
      restart: () => {
        claim();
        const firstStepId = courseReplayStartStep(
          activeOllTopics,
          ollLesson.currentStepId,
        );
        markPlaybackCourse(firstStepId ?? ollLesson.currentStepId);
        beginFreshInkPlayback();
        // The Runtime contains every course on this infinite whiteboard.
        // Replaying from the global cursor would restart the first historical
        // course. The top-bar replay control instead starts at the first Step
        // of the course the learner is currently viewing.
        if (firstStepId) ollLesson.playStep(firstStepId);
        else ollLesson.restart();
      },
      nextBeat: () => {
        claim();
        ollLesson.nextBeat();
      },
      playStep: (stepId: string) => {
        claim();
        markPlaybackCourse(stepId);
        if (ollLesson.deliverySettled || ollLesson.completed) {
          beginFreshInkPlayback();
        }
        ollLesson.playStep(stepId);
      },
      playBeat: (beatId: string) => {
        claim();
        markPlaybackBeatCourse(beatId);
        if (ollLesson.deliverySettled || ollLesson.completed) {
          beginFreshInkPlayback();
        }
        ollLesson.playBeat(beatId);
      },
      setVariable: (alias: string, value: number) => {
        ollLesson.setVariable(alias, value);
      },
      handleStudentVariableInput: (
        alias: string,
        value: number,
        event: Parameters<typeof ollLesson.handleStudentVariableInput>[2],
      ) => {
        return ollLesson.handleStudentVariableInput(alias, value, event);
      },
      handleStudentScene3dInput: (
        nodeId: string,
        view: Parameters<typeof ollLesson.handleStudentScene3dInput>[1],
        event: Parameters<typeof ollLesson.handleStudentScene3dInput>[2],
      ) => {
        return ollLesson.handleStudentScene3dInput(nodeId, view, event);
      },
    };
  }, [
    beginFreshInkPlayback,
    activeOllTopics,
    markPlaybackBeatCourse,
    markPlaybackCourse,
    ollLesson,
    ollOpenSource,
  ]);
  const handleInkMergeComplete = useCallback((
    sourceSessionId: string,
    targetSessionId: string,
  ) => {
    // Opening an older saved whiteboard can start a one-time recovery merge.
    // If the learner presses Replay before that asynchronous merge finishes,
    // its completion belongs to the old document and must not reveal student
    // additions inside the newer replay run.
    setInkMergeSourceSessionId((currentSourceSessionId) =>
      isCurrentInkMergeCompletion(
        sourceSessionId,
        targetSessionId,
        currentSourceSessionId,
        inkDocumentSessionId(sessionId, inkPlaybackRun),
      ) ? null : currentSourceSessionId);
  }, [inkPlaybackRun, sessionId]);
  useEffect(() => {
    if (inkMergeSourceSessionId !== null) return;
    try {
      window.localStorage.removeItem(inkMergeSourceStorageKey(sessionId));
      window.localStorage.setItem(
        cumulativeInkRunStorageKey(sessionId),
        String(inkPlaybackRun),
      );
    } catch {
      // The in-memory state is sufficient for this page load.
    }
  }, [inkMergeSourceSessionId, inkPlaybackRun, sessionId]);
  const [fileListError, setFileListError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [selectionEnhancementPending, setSelectionEnhancementPending] =
    useState(false);
  const [cameraSettingsOpen, setCameraSettingsOpen] = useState(false);
  const cameraSettings = conv.cameraSettings ?? DEFAULT_CAMERA_FRAME_SETTINGS;
  const completedArtifactFilenames = completedTurnId
    ? new Set([
        `${completedTurnId}.octos-lesson.json`,
        `${completedTurnId}.octos-selection-enhancement.json`,
      ])
    : null;
  const completedThreadHasArtifact = Boolean(
    completedTurnId && threadHasDeliverableArtifact(threads, completedTurnId),
  );
  const completedTurnHasArtifact = Boolean(
    completedThreadHasArtifact || (
      completedArtifactFilenames && [
        ...ollArtifacts,
        ...selectionArtifacts,
      ].some((artifact) => completedArtifactFilenames.has(
        artifact.filename.replaceAll("\\", "/").split("/").at(-1) ?? "",
      ))
    ),
  );
  const completedTurn = completedTurnId
    ? conv.turns.find((candidate) => candidate.id === completedTurnId)
    : undefined;
  const completedAssistantText = completedTurn?.assistantText.trim() ?? "";

  useEffect(() => {
    if (!completedTurnId) return;
    // Assistant completion and the voice transcript are independent events.
    // Never classify an audio turn while its transcript is still pending: a
    // late transcript must be allowed to turn this into a real learner turn.
    if (!completedTurn || completedTurn.awaitingTranscript) return;
    if (!completedTurn.userText.trim()) {
      const timer = window.setTimeout(() => {
        setPlainReply(null);
        setPlainReplySpoken(false);
        setCompletedTurnId(null);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (completedTurnHasArtifact || !completedAssistantText) return;
    const timer = window.setTimeout(() => {
      setPlainReply({ turnId: completedTurnId, text: completedAssistantText });
      setCompletedTurnId(null);
    }, 2_500);
    return () => window.clearTimeout(timer);
  }, [
    completedAssistantText,
    completedTurn,
    completedTurnHasArtifact,
    completedTurnId,
  ]);

  useEffect(() => {
    if (!plainReply) return;
    const artifactFilenames = new Set([
      `${plainReply.turnId}.octos-lesson.json`,
      `${plainReply.turnId}.octos-selection-enhancement.json`,
    ]);
    const threadHasArtifact = threadHasDeliverableArtifact(
      threads,
      plainReply.turnId,
    );
    if (threadHasArtifact || [...ollArtifacts, ...selectionArtifacts].some(
      (artifact) => artifactFilenames.has(
        artifact.filename.replaceAll("\\", "/").split("/").at(-1) ?? "",
      ),
    )) {
      const timer = window.setTimeout(() => {
        setPlainReply(null);
        setPlainReplySpoken(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [ollArtifacts, plainReply, selectionArtifacts, threads]);

  useEffect(() => {
    if (ollFixture) return;
    let cancelled = false;
    let requestVersion = 0;
    const loadPersistedArtifacts = async () => {
      const version = ++requestVersion;
      try {
        const files = await getSessionFiles(sessionId);
        if (cancelled || version !== requestVersion) return;
        setPersistedOllArtifacts(collectPersistedOllLessonArtifacts(files));
        setPersistedSelectionArtifacts(
          collectPersistedSelectionEnhancementArtifacts(files),
        );
        setFileListError(null);
      } catch (cause) {
        if (cancelled || version !== requestVersion) return;
        setFileListError(
          cause instanceof Error
            ? cause.message
            : "无法读取已保存的白板课程",
        );
      }
    };
    const handleToolProgress = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string;
        tool?: string;
        message?: string;
        terminal?: boolean;
      }>).detail;
      if (
        detail?.sessionId !== sessionId ||
        detail.tool !== "oll_generate_lesson"
      ) return;
      setOllGenerationSessionId(detail.terminal === true ? null : sessionId);
      if (
        detail.terminal === true ||
        detail.message?.includes("[artifact:oll_lesson_part]") ||
        detail.message?.includes('"stage":"lesson-artifact-ready"')
      ) {
        void loadPersistedArtifacts();
      }
    };
    const applyLessonJobUpdate = async (job: SkillActionJob) => {
      if (
        !job
        || job.session_id !== sessionId
        || job.action_id !== "learning.lesson.generate"
      ) return;
      const pending = pendingLessonJobsRef.current.get(job.job_id);
      if (!pending) return;
      if (job.status === "queued" || job.status === "running") {
        setOllGenerationSessionId(sessionId);
        return;
      }
      pendingLessonJobsRef.current.delete(job.job_id);
      savePendingLessonJobs(sessionId, pendingLessonJobsRef.current);
      const sameTurnStillRunning = [...pendingLessonJobsRef.current.values()]
        .some((candidate) => candidate.turnId === pending.turnId);
      if (sameTurnStillRunning) return;
      setOllGenerationSessionId(null);
      let artifacts: ReturnType<typeof collectPersistedOllLessonArtifacts> = [];
      try {
        const files = await getSessionFiles(sessionId);
        artifacts = collectPersistedOllLessonArtifacts(files);
        setPersistedOllArtifacts(artifacts);
      } catch {
        // The ordinary session-file refresh path can retry after reconnect.
      }
      const keptPartialLesson = artifacts.some(
        (artifact) => artifact.turnId === pending.turnId,
      );
      if (job.status === "succeeded") {
        const nonLesson = lessonJobNonLessonResponse(job);
        if (nonLesson) {
          handleTurnComplete(pending.turnId);
          if (nonLesson.disposition === "ignore") {
            discardWhiteboardQuestion(pending.turnId);
            setCompletedTurnId(null);
            return;
          }
          if (nonLesson.learnerResponse) {
            setPlainReply({
              turnId: pending.turnId,
              text: nonLesson.learnerResponse,
            });
            setPlainReplySpoken(false);
          }
          return;
        }
        setWhiteboardQuestionStatus(pending.turnId, "answered");
        handleTurnComplete(pending.turnId);
        return;
      }
      if (keptPartialLesson) {
        setWhiteboardQuestionStatus(pending.turnId, "answered");
        setSendError("后续课程内容没有生成完成，已经保留并展示成功生成的部分。");
        handleTurnComplete(pending.turnId);
        return;
      }
      const message = lessonJobError(job);
      failedQuestionErrorsRef.current.set(pending.turnId, message);
      updateWhiteboardQuestion(pending.turnId, {
        status: "failed",
        error: message,
      });
      setPlainReply({ turnId: pending.turnId, text: message });
      setPlainReplySpoken(false);
      setSendError(message);
    };
    const handleLessonJobUpdated = (event: Event) => {
      const job = (event as CustomEvent<SkillActionJob>).detail;
      if (job) void applyLessonJobUpdate(job);
    };
    const restorePendingLessonJobs = () => {
      if (pendingLessonJobsRef.current.size === 0) return;
      setOllGenerationSessionId(sessionId);
      void listSkillActionJobs(sessionId, {
        actionId: "learning.lesson.generate",
      }).then((jobs) => {
        jobs.forEach((job) => void applyLessonJobUpdate(job));
      }).catch(() => {
        // The bridge-connected event retries after reconnect.
      });
    };
    const handleBridgeConnected = () => {
      void loadPersistedArtifacts();
      restorePendingLessonJobs();
    };
    window.addEventListener("crew:bridge_connected", handleBridgeConnected);
    window.addEventListener("crew:tool_progress", handleToolProgress);
    window.addEventListener(
      "crew:skill_action_job_updated",
      handleLessonJobUpdated,
    );
    void loadPersistedArtifacts();
    restorePendingLessonJobs();
    return () => {
      cancelled = true;
      window.removeEventListener(
        "crew:bridge_connected",
        handleBridgeConnected,
      );
      window.removeEventListener("crew:tool_progress", handleToolProgress);
      window.removeEventListener(
        "crew:skill_action_job_updated",
        handleLessonJobUpdated,
      );
    };
  }, [
    discardWhiteboardQuestion,
    handleTurnComplete,
    ollFixture,
    sessionId,
    setWhiteboardQuestionStatus,
    updateWhiteboardQuestion,
  ]);

  useEffect(() => {
    let cancelled = false;
    for (const controller of selectionArtifactRequestsRef.current.values()) {
      controller.abort();
    }
    selectionArtifactRequestsRef.current.clear();
    requestedSelectionArtifactsRef.current.clear();
    selectionStateRef.current = null;
    setSelectionState(null);
    setLoadedSelectionArtifacts({});
    void loadSelectionEnhancementState(sessionId).then((state) => {
      if (cancelled) return;
      selectionStateRef.current = state;
      setSelectionState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!voiceEnabled) {
      conv.stop({ preserveCamera: true });
      return;
    }
    if (!runtime.ready) return;
    unlockAudio();
    void conv.start(
      initialAudio ? { initialAudio, includeCamera: false } : undefined,
    );
    // The conversation hook owns unmount cleanup and exposes stable controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.ready, voiceEnabled]);

  useEffect(() => {
    for (const turn of conv.turns) {
      const text = turn.userText.trim();
      if (!text) continue;
      if (!voiceQuestionSourcesRef.current.has(turn.id)) continue;
      const thread = threads.find((candidate) => candidate.id === turn.id);
      const questionId = thread?.turnId ?? turn.id;
      registerVoiceQuestion(
        questionId,
        text,
        voiceQuestionSourcesRef.current.get(turn.id) ?? null,
      );
    }
    onTurnsChange?.(conv.turns);
  }, [conv.turns, onTurnsChange, registerVoiceQuestion, threads]);

  useEffect(() => {
    if (ollFixture || ollArtifacts.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      setWhiteboardQuestions((current) => {
        const known = new Set(current.map((question) => question.id));
        const recovered = ollArtifacts.flatMap((artifact, index) => {
          if (known.has(artifact.turnId)) return [];
          const thread = threads.find((candidate) =>
            candidate.id === artifact.threadId
            || candidate.id === artifact.turnId
            || candidate.turnId === artifact.turnId);
          const turn = conv.turns.find((candidate) =>
            candidate.id === thread?.id
            || candidate.id === artifact.threadId
            || candidate.id === artifact.turnId);
          const text = turn?.userText.trim();
          if (!text) return [];
          known.add(artifact.turnId);
          const threadTimestamp = thread?.userMsg.timestamp;
          const createdAt = typeof threadTimestamp === "number"
            && Number.isFinite(threadTimestamp)
            ? new Date(threadTimestamp).toISOString()
            : new Date(Date.now() + index).toISOString();
          return [{
            id: artifact.turnId,
            sessionId,
            text,
            origin: "composer" as const,
            createdAt,
            status: "answered" as const,
          }];
        });
        if (recovered.length === 0) return current;
        return [...current, ...recovered].sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt));
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conv.turns, ollArtifacts, ollFixture, sessionId, threads]);

  useEffect(() => {
    const ollArtifactRequests = ollArtifactRequestsRef.current;
    const selectionArtifactRequests = selectionArtifactRequestsRef.current;
    return () => {
      for (const controller of ollArtifactRequests.values()) {
        controller.abort();
      }
      ollArtifactRequests.clear();
      for (const controller of selectionArtifactRequests.values()) {
        controller.abort();
      }
      selectionArtifactRequests.clear();
    };
  }, []);

  useEffect(() => {
    const pending = ollArtifacts.filter(
      (artifact) =>
        !requestedOllArtifactsRef.current.has(artifact.path),
    );
    if (pending.length === 0) return;
    pending.forEach((artifact) => {
      const artifactIdentity = ollArtifactIdentity(artifact);
      const controller = new AbortController();
      requestedOllArtifactsRef.current.add(artifact.path);
      ollArtifactRequestsRef.current.get(artifactIdentity)?.abort();
      ollArtifactRequestsRef.current.set(artifactIdentity, controller);
      loadOllLessonArtifact(artifact, sessionId, controller.signal)
        .then((events) => {
          if (ollArtifactRequestsRef.current.get(artifactIdentity) !== controller) {
            return;
          }
          setLoadedOllArtifacts((current) => ({
            ...current,
            [artifactIdentity]: events,
          }));
          setRejectedOllArtifactIds((current) => {
            if (!current.has(artifactIdentity)) return current;
            const next = new Set(current);
            next.delete(artifactIdentity);
            return next;
          });
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setRejectedOllArtifactIds((current) => {
            const next = new Set(current);
            next.add(artifactIdentity);
            return next;
          });
          setArtifactError(
            cause instanceof Error ? cause.message : "OLL 课程读取失败",
          );
        })
        .finally(() => {
          if (
            ollArtifactRequestsRef.current.get(artifactIdentity) === controller
          ) {
            ollArtifactRequestsRef.current.delete(artifactIdentity);
          }
        });
    });
  }, [ollArtifacts, sessionId]);

  useEffect(() => {
    if (!selectionState) return;
    const pending = selectionArtifacts.filter(
      (artifact) => !requestedSelectionArtifactsRef.current.has(artifact.path),
    );
    if (pending.length === 0) return;
    pending.forEach((artifact) => {
      const controller = new AbortController();
      requestedSelectionArtifactsRef.current.add(artifact.path);
      selectionArtifactRequestsRef.current.set(artifact.path, controller);
      loadSelectionEnhancementArtifact(artifact, sessionId, controller.signal)
        .then((loaded) => {
          const source = selectionState.sources.find(
            (candidate) => candidate.source_id === loaded.source.source_id,
          );
          // The generated artifact is durable server-side while its source SVG
          // is browser-local. A missing local source must not make the already
          // generated result disappear after refresh or on another browser.
          // When a source is present, keep enforcing its immutable checksum.
          if (source && !selectionArtifactMatchesSource(loaded, source)) {
            throw new Error("选区辅助内容无法对应到已保存的原稿快照");
          }
          setLoadedSelectionArtifacts((current) => ({
            ...current,
            [artifact.path]: loaded,
          }));
        })
        .catch((cause) => {
          requestedSelectionArtifactsRef.current.delete(artifact.path);
          if (controller.signal.aborted) return;
          setArtifactError(
            cause instanceof Error ? cause.message : "选区辅助内容读取失败",
          );
        })
        .finally(() => {
          if (
            selectionArtifactRequestsRef.current.get(artifact.path)
              === controller
          ) {
            selectionArtifactRequestsRef.current.delete(artifact.path);
          }
        });
    });
  }, [selectionArtifacts, selectionState, sessionId]);

  const appendOllEvents = ollLesson?.appendEvents;

  useEffect(() => {
    // A changed lesson.open creates a new BrowserLessonSession. Re-submit the
    // complete delivered prefix: an upgraded checkpoint will deduplicate its
    // accepted Steps, while a rejected stale checkpoint needs every Step from
    // sequence 1 again.
    appendedOllEventCountRef.current = 1;
  }, [ollOpenSource]);

  useEffect(() => {
    if (!activeOllEvents || !appendOllEvents) return;
    if (appendedOllEventCountRef.current > activeOllEvents.length) {
      appendedOllEventCountRef.current = 1;
    }
    if (playbackMode === "review") {
      const pending = activeOllEvents.slice(appendedOllEventCountRef.current);
      if (pending.length > 0) appendOllEvents(pending);
      appendedOllEventCountRef.current = activeOllEvents.length;
      return;
    }
    let eventIndex = appendedOllEventCountRef.current;
    let timer: number | undefined;
    const appendNext = () => {
      const event = activeOllEvents[eventIndex] as CanonicalEvent | undefined;
      if (!event) return;
      appendOllEvents([event]);
      eventIndex += 1;
      appendedOllEventCountRef.current = eventIndex;
      if (eventIndex < activeOllEvents.length) {
        timer = window.setTimeout(appendNext, 240);
      }
    };
    timer = window.setTimeout(appendNext, 240);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeOllEvents, appendOllEvents, playbackMode]);
  useEffect(() => {
    if (ollLesson) {
      onBoardContextChange?.({
        lastAppliedAction: ollLesson.currentOperation?.action?.action_id,
        boardSummary: `${ollLesson.title}；进度 ${ollLesson.cursor}/${ollLesson.totalOperations}`,
      });
      return;
    }
    onBoardContextChange?.({});
  }, [ollLesson, onBoardContextChange]);

  const ollNarrationActive = Boolean(
    ollLesson?.playing && ollLesson.activeSpeech.trim(),
  );
  const plainReplyNarrationId = plainReply && !plainReplySpoken && !lessonOwnsNarration
    ? `plain-reply:${plainReply.turnId}`
    : undefined;
  const startOllNarration = ollLesson?.startNarration;
  const completeOllNarration = ollLesson?.completeNarration;
  const handleNarrationStart = useCallback((narrationId: string) => {
    if (!narrationId.startsWith("plain-reply:")) {
      startOllNarration?.(narrationId);
    }
  }, [startOllNarration]);
  const handleNarrationComplete = useCallback((narrationId: string) => {
    if (narrationId.startsWith("plain-reply:")) {
      setPlainReplySpoken(true);
      return;
    }
    completeOllNarration?.(narrationId);
  }, [completeOllNarration]);
  const ollNarrationTts = useOllNarrationTts({
    enabled: narrationAudioEnabled && (Boolean(ollLesson) || Boolean(plainReply)),
    playing: lessonOwnsNarration
      ? ollNarrationActive
      : Boolean(plainReplyNarrationId),
    text: lessonOwnsNarration
      ? ollLesson?.activeSpeech ?? ""
      : plainReply?.text ?? "",
    narrationId: lessonOwnsNarration
      ? ollLesson?.currentBeatId
      : plainReplyNarrationId,
    prefetchEnabled: lessonOwnsNarration,
    upcomingText: lessonOwnsNarration
      ? ollLesson?.nextNarration?.text
      : undefined,
    upcomingNarrationId: lessonOwnsNarration
      ? ollLesson?.nextNarration?.beatId
      : undefined,
    onSpeakingChange: setNarrationSpeechActive,
    onPlaybackStart: handleNarrationStart,
    onPlaybackComplete: handleNarrationComplete,
  });

  const buildTurnText = useCallback(
    (turnId: string, mediaPaths: string[], visibleText: string) => {
      const context =
        conversationOptions?.buildTurnText?.({
          sessionId,
          turnId,
          mediaPaths,
        }) ?? "";
      return [context, visibleText].filter(Boolean).join("\n");
    },
    [conversationOptions, sessionId],
  );

  const rememberSelectionSource = useCallback(
    async (snapshot: InkSelectionSnapshot) => {
      const current = selectionStateRef.current
        ?? await loadSelectionEnhancementState(sessionId);
      const next = addSelectionSource(current, snapshot);
      saveSelectionEnhancementState(next);
      selectionStateRef.current = next;
      setSelectionState(next);
    },
    [sessionId],
  );

  const sendSelectionQuestion = useCallback(
    async ({
      snapshot,
      question,
      contentKind,
      recognizedContent,
      recognitionConfidence,
      toolId,
      boardContext,
      contextImage,
    }: {
      snapshot: InkSelectionSnapshot;
      question: string;
      contentKind: SelectionContentKind;
      recognizedContent?: string;
      recognitionConfidence?: "high" | "medium" | "low";
      toolId: SelectionToolId;
      boardContext: SelectionBoardContext;
      contextImage: File;
    }) => {
      unlockAudio();
      setSendError(null);
      setTextTurnPending(true);
      setSelectionEnhancementPending(true);
      const turnId = crypto.randomUUID();
      addWhiteboardQuestion({
        id: turnId,
        sessionId,
        text: question,
        origin: "selection",
        createdAt: new Date().toISOString(),
        status: "pending",
        source: {
          sourceId: snapshot.source_id,
          bounds: { ...snapshot.bounds },
        },
      });
      onLearnerInput?.(question);
      try {
        await rememberSelectionSource(snapshot);
        const paths = await uploadFiles([contextImage], "upload");
        const mediaPath = paths[0];
        if (!mediaPath) throw new Error("选区图片上传后没有可用路径");
        const actionArguments = buildSelectionEnhancementActionArguments({
          sessionId,
          turnId,
          mediaPath,
          source: snapshot,
          contentKind,
          recognizedContent,
          recognitionConfidence,
          learnerRequest: question,
          lessonTitle: ollLesson?.title,
          boardSummary: ollLesson
            ? `${ollLesson.title}；进度 ${ollLesson.cursor}/${ollLesson.totalOperations}`
            : undefined,
          boardContext,
          toolId,
        });
        const invocation = await invokeSkillAction(
          sessionId,
          "learning.selection.enhance",
          actionArguments,
        );
        const failedResult = (invocation.results ?? [])
          .find((result) => !result.success);
        if (!invocation.ok || failedResult) {
          throw new Error(
            failedResult?.output?.trim()
              || "选区辅助内容生成失败，请重试",
          );
        }
        const files = await getSessionFiles(sessionId);
        const artifacts = collectPersistedSelectionEnhancementArtifacts(files);
        if (!artifacts.some((artifact) => artifact.turnId === turnId)) {
          throw new Error(
            "没有生成可显示的选区结果。这个内容可能暂不支持，请重试或改用“问小章鱼”查看原因。",
          );
        }
        setPersistedSelectionArtifacts(artifacts);
        setTextTurnPending(false);
        setSelectionEnhancementPending(false);
        setWhiteboardQuestionStatus(turnId, "answered");
        handleTurnComplete(turnId);
      } catch (cause) {
        const message = cause instanceof Error
          ? cause.message
          : "选区问题发送失败";
        setTextTurnPending(false);
        setSelectionEnhancementPending(false);
        updateWhiteboardQuestion(turnId, { status: "failed", error: message });
        // Selection failures stay attached to their question on the board.
        // Resolving here prevents the whiteboard toolbar and the workspace
        // shell from rendering duplicate error notices outside that card.
      }
    },
    [
      handleTurnComplete,
      addWhiteboardQuestion,
      ollLesson,
      onLearnerInput,
      rememberSelectionSource,
      sessionId,
      setWhiteboardQuestionStatus,
      updateWhiteboardQuestion,
    ],
  );

  const classifyInkSelection = useCallback(
    async ({
      snapshot,
      boardContext,
      selectionImage,
    }: {
      snapshot: InkSelectionSnapshot;
      boardContext: SelectionBoardContext;
      selectionImage: File;
    }): Promise<SelectionClassification> => {
      const paths = await uploadFiles([selectionImage], "upload");
      const mediaPath = paths[0];
      if (!mediaPath) throw new Error("选区图片上传后没有可用路径");
      const invocation = await invokeSkillAction(
        sessionId,
        "learning.selection.classify",
        buildSelectionClassificationActionArguments({
          turnId: crypto.randomUUID(),
          mediaPath,
          source: snapshot,
          boardContext,
        }),
      );
      if (!invocation.ok || (invocation.results ?? []).some((candidate) => !candidate.success)) {
        throw new Error("暂时无法识别选区内容");
      }
      const result = invocation.results?.find((candidate) =>
        candidate.success && candidate.structured_metadata !== undefined,
      );
      if (!result) throw new Error("选区识别没有返回可用结果");
      return parseSelectionClassificationMetadata(result.structured_metadata);
    },
    [sessionId],
  );

  const startSelectionVoiceQuestion = useCallback(
    async ({
      snapshot,
      contentKind,
      boardContext,
      contextImage,
    }: {
      snapshot: InkSelectionSnapshot;
      contentKind: SelectionContentKind;
      boardContext: SelectionBoardContext;
      contextImage: File;
    }) => {
      await rememberSelectionSource(snapshot);
      pendingVoiceSelectionRef.current = {
        snapshot,
        contentKind,
        boardContext,
        file: contextImage,
        claimed: false,
      };
      if (conv.state === "idle" || conv.state === "error") {
        await conv.start();
      }
    },
    [conv, rememberSelectionSource],
  );

  const referenceSelectionForLesson = useCallback(async ({
    snapshot,
    contentKind,
    boardContext,
    contextImage,
    label,
  }: {
    snapshot: InkSelectionSnapshot;
    contentKind: SelectionContentKind;
    boardContext: SelectionBoardContext;
    contextImage: File;
    label: string;
  }) => {
    await rememberSelectionSource(snapshot);
    const reference: ComposerBoardReference = {
      id: `board-selection:${crypto.randomUUID()}`,
      label,
      snapshot,
      contentKind,
      boardContext,
      contextImage,
    };
    setComposerBoardReferences((current) => [
      ...current.filter((candidate) =>
        candidate.snapshot.source_id !== snapshot.source_id,
      ),
      reference,
    ].slice(-4));
  }, [rememberSelectionSource]);

  const deleteSelectionEnhancement = useCallback((turnId: string) => {
    setSelectionState((current) => {
      if (!current) return current;
      const next = hideSelectionEnhancement(current, turnId);
      saveSelectionEnhancementState(next);
      selectionStateRef.current = next;
      return next;
    });
    // The question and result are one auxiliary card. Removing only the
    // artifact leaves an answered question behind, which is then rendered as
    // a fake loading card.
    setWhiteboardQuestions((current) => current.filter((question) =>
      question.id !== turnId));
  }, []);

  const deleteSelectionSources = useCallback((sourceIds: string[]) => {
    const ids = new Set(sourceIds);
    if (ids.size === 0) return;
    const matchingTurnIds = new Set([
      ...Object.values(loadedSelectionArtifacts)
        .filter((artifact) => ids.has(artifact.source.source_id))
        .map((artifact) => artifact.turn_id),
      ...whiteboardQuestions
        .filter((question) => question.origin === "selection"
          && question.source
          && ids.has(question.source.sourceId))
        .map((question) => question.id),
    ]);
    setSelectionState((current) => {
      if (!current) return current;
      const next = removeSelectionSources(current, ids, matchingTurnIds);
      saveSelectionEnhancementState(next);
      selectionStateRef.current = next;
      return next;
    });
    setWhiteboardQuestions((current) => current.filter((question) =>
      question.origin !== "selection"
      || !question.source
      || !ids.has(question.source.sourceId)));
    setComposerBoardReferences((current) => current.filter((reference) =>
      !ids.has(reference.snapshot.source_id)));
    const pendingVoice = pendingVoiceSelectionRef.current;
    if (pendingVoice && ids.has(pendingVoice.snapshot.source_id)) {
      pendingVoiceSelectionRef.current = null;
    }
  }, [loadedSelectionArtifacts, whiteboardQuestions]);

  const sendText = useCallback(
    async (text: string, applicationContext?: string) => {
      unlockAudio();
      setSendError(null);
      setTextTurnPending(true);
      const turnId = crypto.randomUUID();
      const references = composerBoardReferences;
      addWhiteboardQuestion({
        id: turnId,
        sessionId,
        text,
        origin: "composer",
        createdAt: new Date().toISOString(),
        status: "pending",
      });
      onLearnerInput?.(text);
      try {
        if (references.some((reference) =>
          !selectionBoardContextTargetsExist(
            reference.boardContext,
            ollLesson?.board ?? null,
          ),
        )) {
          throw new Error("引用的白板内容已经变化，请重新框选后再发送");
        }
        const mediaPaths = references.length > 0
          ? await uploadFiles(
              references.map((reference) => reference.contextImage),
              "upload",
            )
          : [];
        if (mediaPaths.length !== references.length) {
          throw new Error("白板引用上传不完整");
        }
        const referenceContext = buildComposerBoardReferenceContext(
          references.map((reference, index) => ({
            reference,
            mediaPath: mediaPaths[index]!,
          })),
        );
        if (references.length === 0 && !applicationContext?.trim()) {
          await startDirectLessonGeneration(turnId, text);
          return;
        }
        sendMessage({
          sessionId,
          text: [
            buildTurnText(turnId, mediaPaths, text),
            applicationContext,
            referenceContext,
          ]
            .filter(Boolean)
            .join("\n"),
          media: mediaPaths,
          clientMessageId: turnId,
          onComplete: () => {
            setTextTurnPending(false);
            setComposerBoardReferences((current) => current.filter(
              (candidate) => !references.some(
                (reference) => reference.id === candidate.id,
              ),
            ));
            setWhiteboardQuestionStatus(turnId, "answered");
            handleTurnComplete(turnId);
          },
          onError: (error) => {
            setTextTurnPending(false);
            setWhiteboardQuestionStatus(turnId, "failed");
            setSendError(error.message || "发送失败");
          },
        });
      } catch (cause) {
        setTextTurnPending(false);
        setWhiteboardQuestionStatus(turnId, "failed");
        setSendError(cause instanceof Error ? cause.message : "发送失败");
        throw cause;
      }
    },
    [
      buildTurnText,
      addWhiteboardQuestion,
      composerBoardReferences,
      handleTurnComplete,
      ollLesson,
      onLearnerInput,
      sessionId,
      startDirectLessonGeneration,
      setWhiteboardQuestionStatus,
    ],
  );

  const sendImage = useCallback(
    async (file: File) => {
      unlockAudio();
      setSendError(null);
      const turnId = crypto.randomUUID();
      const prompt = "请看我上传的题目，把题目和关键步骤整理到白板上。";
      addWhiteboardQuestion({
        id: turnId,
        sessionId,
        text: prompt,
        origin: "composer",
        createdAt: new Date().toISOString(),
        status: "pending",
      });
      try {
        setTextTurnPending(true);
        const paths = await uploadFiles([file], "upload");
        onLearnerInput?.(prompt);
        sendMessage({
          sessionId,
          text: buildTurnText(
            turnId,
            paths,
            prompt,
          ),
          media: paths,
          clientMessageId: turnId,
          onComplete: () => {
            setTextTurnPending(false);
            setWhiteboardQuestionStatus(turnId, "answered");
            handleTurnComplete(turnId);
          },
          onError: (error) => {
            setTextTurnPending(false);
            setWhiteboardQuestionStatus(turnId, "failed");
            setSendError(error.message || "图片发送失败");
          },
        });
      } catch (cause) {
        setTextTurnPending(false);
        setWhiteboardQuestionStatus(turnId, "failed");
        setSendError(cause instanceof Error ? cause.message : "图片发送失败");
      }
    },
    [
      addWhiteboardQuestion,
      buildTurnText,
      handleTurnComplete,
      onLearnerInput,
      sessionId,
      setWhiteboardQuestionStatus,
    ],
  );

  const retryDegradedVisual = useCallback(async (
    degraded: DegradedVisualRetryRequest,
  ) => {
    await sendText(
      buildDegradedVisualRetryPrompt(degraded),
      buildDegradedVisualRetryContext(degraded),
    );
  }, [sendText]);

  const handleTeacherClick = () => {
    unlockAudio();
    if (lessonOwnsNarration && controlledOllLesson) {
      if (controlledOllLesson.playing) controlledOllLesson.pause();
      else controlledOllLesson.play();
      return;
    }
    if (!voiceEnabled) {
      if (controlledOllLesson) {
        if (controlledOllLesson.playing) controlledOllLesson.pause();
        else controlledOllLesson.play();
      }
      return;
    }
    if (conv.state === "speaking" || conv.state === "thinking") {
      conv.interrupt();
      controlledOllLesson?.pause();
      return;
    }
    if (conv.state === "idle" || conv.state === "error") {
      void conv.start();
    }
  };

  const handleUseVoiceMode = async () => {
    setSendError(null);
    try {
      await onUseVoiceMode?.();
    } catch (cause) {
      setSendError(
        cause instanceof Error
          ? cause.message
          : "无法启用语音",
      );
    }
  };

  const closeCameraSettings = useCallback(() => {
    setCameraSettingsOpen(false);
  }, []);

  const openCameraSettings = useCallback(() => {
    setCameraSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (!cameraSettingsOpen) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCameraSettings();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [cameraSettingsOpen, closeCameraSettings]);

  const teacherSpeech = lessonOwnsNarration
    ? ollLesson?.activeSpeech ?? ""
    : plainReply?.text ??
      (textTurnPending
        ? "我正在整理这道题，马上写到白板上。"
        : ollLesson
          ? ollLesson.activeSpeech ||
            (lessonDeliverySettled
              ? "这节课讲完了，你可以缩放白板回顾刚才的内容。"
              : "")
          : conv.state === "thinking"
            ? "我正在准备白板课程。"
            : "");
  const teacherState = textTurnPending
    ? "thinking"
    : lessonOwnsNarration
      ? "speaking"
      : conv.state;
  const teacherStateLabel = textTurnPending
    ? "正在想"
    : lessonOwnsNarration
      ? "课程播放中"
      : ollLesson
        ? lessonDeliverySettled
          ? "课程完成"
          : "继续播放"
        : undefined;
  const pendingLessonQuestion = [...whiteboardQuestions].reverse().find(
    (question) => question.origin === "composer" && question.status === "pending",
  );
  const pendingLessonHasPlayableArtifact = Boolean(
    pendingLessonQuestion && ollArtifacts.some((artifact) =>
      artifact.turnId === pendingLessonQuestion.id
      && Boolean(loadedOllArtifacts[ollArtifactIdentity(artifact)])),
  );
  const pendingLessonAwaitingFirstArtifact = Boolean(
    pendingLessonQuestion && !pendingLessonHasPlayableArtifact,
  );
  const lessonLoading = !selectionEnhancementPending && (
    pendingLessonAwaitingFirstArtifact
    || (
      !plainReply
      && !completedTurnHasArtifact
      && (
        textTurnPending
        || conv.state === "thinking"
        || Boolean(completedTurnId)
        || ollGenerationSessionId === sessionId
      )
    )
  );
  const lessonGenerationInProgress = Boolean(
    ollLesson && ollGenerationSessionId === sessionId,
  );
  const whiteboardLoadingState: WhiteboardLoadingState | null = lessonLoading
    && (!ollLesson || Boolean(
      pendingLessonQuestion && !pendingLessonHasPlayableArtifact,
    ))
    ? {
        id: pendingLessonQuestion?.id ?? completedTurnId ?? `lesson:${sessionId}`,
        kind: "lesson",
        title: "正在搭建这节课",
        detail: "先整理重点，再把讲解和互动画面放到白板上。",
      }
    : null;

  return (
    <div className="learning-workspace">
      <header className="learning-workspace-topbar">
        <div>
          <span>Octos Learning Canvas</span>
          <strong>{ollLesson?.title ?? "新的学习白板"}</strong>
        </div>
        {ollLesson ? (
          <div className="learning-demo-controls" data-testid="oll-controls">
            <button
              type="button"
              onClick={() => {
                unlockAudio();
                if (controlledOllLesson?.playing) controlledOllLesson.pause();
                else controlledOllLesson?.play();
              }}
              aria-label={ollLesson.playing ? "暂停 OLL 课程" : "播放 OLL 课程"}
              disabled={lessonDeliverySettled}
            >
              {ollLesson.playing ? <Pause size={17} /> : <Play size={17} />}
            </button>
            <button
              type="button"
              onClick={() => {
                unlockAudio();
                controlledOllLesson?.nextBeat();
              }}
              aria-label="下一 OLL Beat"
              disabled={lessonDeliverySettled}
            >
              <ChevronRight size={17} />
            </button>
            <button
              type="button"
              onClick={() => {
                unlockAudio();
                controlledOllLesson?.restart();
              }}
              aria-label="重新播放 OLL 课程"
            >
              <RotateCcw size={16} />
            </button>
            <button
              type="button"
              onClick={() => {
                unlockAudio();
                setNarrationAudioEnabled((enabled) => !enabled)
              }}
              aria-label={
                narrationAudioEnabled
                  ? "关闭课程旁白语音"
                  : "开启课程旁白语音"
              }
              aria-pressed={narrationAudioEnabled}
            >
              {narrationAudioEnabled
                ? <Volume2 size={16} />
                : <VolumeX size={16} />}
            </button>
            {lessonGenerationInProgress ? (
              <div
                className="learning-course-generation-status"
                role="status"
                aria-label="课程内容仍在生成"
              >
                <i aria-hidden="true" />
                <span>继续生成中</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="learning-workspace-actions">
          <button
            type="button"
            className={`learning-mode-button ${voiceEnabled ? "is-active" : ""}`}
            onClick={voiceEnabled ? onUseTextMode : () => void handleUseVoiceMode()}
            aria-label={voiceEnabled ? "关闭语音" : "启用语音"}
            aria-pressed={voiceEnabled}
          >
            {voiceEnabled ? <Mic size={16} /> : <MicOff size={16} />}
            <span>{voiceEnabled ? "关闭语音" : "启用语音"}</span>
          </button>
          <button
            type="button"
            className={`learning-mode-button ${conv.cameraActive ? "is-active" : ""}`}
            onClick={conv.toggleCamera}
            aria-label={conv.cameraActive ? "关闭摄像头" : "启用摄像头"}
            aria-pressed={conv.cameraActive}
          >
            {conv.cameraActive ? <Camera size={16} /> : <CameraOff size={16} />}
            <span>{conv.cameraActive ? "关闭摄像头" : "启用摄像头"}</span>
          </button>
        </div>
      </header>

      <main className="learning-canvas-shell">
        <LearningWhiteboard
          runtime={controlledOllLesson ?? ollLesson}
          inkSessionId={inkSessionId}
          loadingState={whiteboardLoadingState}
          questions={replayingWithoutStudentAdditions
            ? whiteboardQuestions.filter((question) => question.origin !== "selection")
            : whiteboardQuestions}
          courseRegions={courseRegions}
          playbackCourseTarget={playbackCourseTarget}
          onPlaceQuestion={placeWhiteboardQuestion}
          onUpdateCourseRegion={updateCourseRegion}
          onInkActivity={onWhiteboardActivity}
          inkMergeSourceSessionId={inkMergeSourceSessionId ?? undefined}
          onInkMergeComplete={handleInkMergeComplete}
          selectionEnhancements={replayingWithoutStudentAdditions
            ? []
            : visibleSelectionEnhancements}
          selectionSources={replayingWithoutStudentAdditions
            ? []
            : selectionState?.sources ?? []}
          onClassifyInkSelection={classifyInkSelection}
          onAskInkSelection={sendSelectionQuestion}
          onVoiceInkSelection={voiceEnabled
            ? startSelectionVoiceQuestion
            : undefined}
          onReferenceInkSelection={referenceSelectionForLesson}
          onDeleteSelectionEnhancement={deleteSelectionEnhancement}
          onDeleteSelectionSources={deleteSelectionSources}
          onRetryDegradedVisual={retryDegradedVisual}
        />
      </main>

      {(conv.cameraStream || conv.lastSentFrameUrl) && (
        <div className="learning-camera-monitor" aria-label="摄像头画面">
          {conv.cameraStream && (
            <div className="learning-camera-frame">
              <CameraPreview
                stream={conv.cameraStream}
                settings={cameraSettings}
              />
              <button
                type="button"
                className="learning-camera-frame-settings"
                onClick={openCameraSettings}
                aria-label="调整摄像头画面"
                aria-expanded={cameraSettingsOpen}
                title="调整画面"
              >
                <Settings2 size={16} />
              </button>
              <span>老师看到的画面</span>
            </div>
          )}
          {conv.lastSentFrameUrl && (
            <div className="learning-camera-frame is-sent">
              <img src={conv.lastSentFrameUrl} alt="本轮已发送给老师的画面" />
              <span>本轮已发送</span>
            </div>
          )}
        </div>
      )}

      {cameraSettingsOpen && (
        <CameraSettingsDialog
          stream={conv.cameraStream}
          settings={cameraSettings}
          error={conv.cameraError}
          temporaryPreview={false}
          onChange={conv.updateCameraSettings}
          onReset={conv.resetCameraSettings}
          onClose={closeCameraSettings}
        />
      )}

      <OctosTeacher
        state={runtime.ready ? teacherState : "error"}
        speech={teacherSpeech}
        preparing={lessonOwnsNarration && ollNarrationTts.preparing}
        stateLabel={runtime.ready ? teacherStateLabel : undefined}
        onClick={handleTeacherClick}
      />

      {controlledOllLesson
        ? <OllCourseOutline runtime={controlledOllLesson} />
        : null}

      <StudentInputDock
        voiceState={
          textTurnPending
            ? "thinking"
            : runtime.ready
              ? conv.state
              : "error"
        }
        cameraActive={conv.cameraActive}
        voiceDisabled={!voiceEnabled || !runtime.ready}
        sendDisabled={
          textTurnPending ||
          (voiceEnabled &&
            (conv.state === "thinking" || conv.state === "speaking"))
        }
        onMic={handleTeacherClick}
        onToggleCamera={conv.toggleCamera}
        onSendText={sendText}
        onSendImage={sendImage}
        references={composerBoardReferences.map(({ id, label }) => ({ id, label }))}
        onRemoveReference={(id) => setComposerBoardReferences((current) =>
          current.filter((reference) => reference.id !== id),
        )}
      />

      {(sendError ||
        fileListError ||
        artifactError ||
        conv.error ||
        conv.cameraError ||
        ollNarrationTts.error) && (
        <div className="learning-error" role="alert">
          {sendError ??
            fileListError ??
            artifactError ??
            conv.error ??
            conv.cameraError ??
            ollNarrationTts.error}
        </div>
      )}
      {voiceEnabled && !runtime.ready && !runtime.loading && (
        <div className="learning-runtime-warning">
          语音引擎尚未就绪，白板示范仍可使用。
        </div>
      )}
    </div>
  );
}
