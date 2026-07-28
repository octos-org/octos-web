import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalEvent } from "octos-lesson-language";
import { parseCanonicalJsonl } from "octos-lesson-language/web-runtime";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { uploadFiles } from "@/api/chat";
import { sendMessage } from "@/runtime/ui-protocol-send";
import { unlockAudio } from "@/home/voice/audio-playback";
import {
  useVoiceConversation,
  type VoiceConversationOptions,
  type VoiceConversationTurn,
} from "@/home/voice/use-voice-conversation";
import { useOminixRuntimeSummary } from "@/home/use-ominix-runtime-summary";
import { useRenderThreads } from "@/store/projection-render-adapter";
import { InfiniteBoard } from "./board/infinite-board";
import {
  collectBoardArtifacts,
  loadBoardArtifact,
} from "./board/board-artifacts";
import { buildAssistantLessonPacket } from "./board/assistant-to-board";
import {
  buildLearningBoardContext,
  mergeSessionBoardPackets,
  type LearningBoardContext,
} from "./board/session-board";
import { useLessonPlayer } from "./board/use-lesson-player";
import type { LessonPacketV1 } from "./board/lesson-packet";
import geometryLessonSource from "./oll/fixtures/geometry-auxiliary-line-v2.canonical.jsonl?raw";
import { OllLessonBoard } from "./oll/oll-lesson-runtime";
import {
  collectOllLessonArtifacts,
  composeOllClassroomEvents,
  loadOllLessonArtifact,
} from "./oll/oll-artifacts";
import { useOllLessonRuntime } from "./oll/use-oll-lesson-runtime";
import { OctosTeacher } from "./octos-teacher";
import { StudentInputDock } from "./student-input-dock";
import "./learning-workspace.css";

const geometryLessonEvents = parseCanonicalJsonl(geometryLessonSource);

export interface LearningWorkspaceProps {
  sessionId: string;
  voiceEnabled?: boolean;
  onUseTextMode?: () => void;
  onLearnerInput?: (text: string) => void;
  initialAudio?: Blob | null;
  conversationOptions?: VoiceConversationOptions;
  onTurnsChange?: (turns: VoiceConversationTurn[]) => void;
  onBoardContextChange?: (context: LearningBoardContext) => void;
  onBack: () => void;
  onVoiceExit?: () => void;
  ollFixture?: "geometry-v2";
}

export function LearningWorkspace({
  sessionId,
  voiceEnabled = true,
  onUseTextMode,
  onLearnerInput,
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
  const conv = useVoiceConversation(
    sessionId,
    undefined,
    onVoiceExit ?? onBack,
    conversationOptions,
  );
  const [loadedArtifacts, setLoadedArtifacts] = useState<
    Record<string, LessonPacketV1>
  >({});
  const [loadedOllArtifacts, setLoadedOllArtifacts] = useState<
    Record<string, CanonicalEvent[]>
  >({});
  const artifacts = useMemo(
    () => collectBoardArtifacts(threads),
    [threads],
  );
  const ollArtifacts = useMemo(
    () => collectOllLessonArtifacts(threads),
    [threads],
  );
  const requestedArtifactsRef = useRef(new Set<string>());
  const requestedOllArtifactsRef = useRef(new Set<string>());
  const [sendError, setSendError] = useState<string | null>(null);
  const [textTurnPending, setTextTurnPending] = useState(false);

  useEffect(() => {
    if (!voiceEnabled || !runtime.ready) return;
    unlockAudio();
    void conv.start(
      initialAudio ? { initialAudio, includeCamera: false } : undefined,
    );
    // The conversation hook owns unmount cleanup and exposes stable controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.ready, voiceEnabled]);

  useEffect(() => {
    onTurnsChange?.(conv.turns);
  }, [conv.turns, onTurnsChange]);

  useEffect(() => {
    const pending = artifacts.filter(
      (artifact) => !requestedArtifactsRef.current.has(artifact.path),
    );
    if (pending.length === 0) return;
    const controller = new AbortController();
    pending.forEach((artifact) => {
      requestedArtifactsRef.current.add(artifact.path);
      loadBoardArtifact(artifact, sessionId, controller.signal)
        .then((nextPacket) => {
          setLoadedArtifacts((current) => ({
            ...current,
            [artifact.path]: nextPacket,
          }));
          setSendError(null);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setSendError(
            cause instanceof Error
              ? cause.message
              : "白板内容读取失败",
          );
        });
    });
    return () => controller.abort();
  }, [artifacts, sessionId]);

  useEffect(() => {
    const pending = ollArtifacts.filter(
      (artifact) => !requestedOllArtifactsRef.current.has(artifact.path),
    );
    if (pending.length === 0) return;
    const controller = new AbortController();
    pending.forEach((artifact) => {
      requestedOllArtifactsRef.current.add(artifact.path);
      loadOllLessonArtifact(artifact, sessionId, controller.signal)
        .then((events) => {
          setLoadedOllArtifacts((current) => ({
            ...current,
            [artifact.path]: events,
          }));
          setSendError(null);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setSendError(
            cause instanceof Error ? cause.message : "OLL 课程读取失败",
          );
        });
    });
    return () => controller.abort();
  }, [ollArtifacts, sessionId]);

  const artifactByThread = useMemo(() => {
    const result = new Map<string, LessonPacketV1>();
    for (const artifact of artifacts) {
      const loaded = loadedArtifacts[artifact.path];
      if (loaded) result.set(artifact.threadId, loaded);
    }
    return result;
  }, [artifacts, loadedArtifacts]);
  const turnPackets = useMemo(
    () =>
      conv.turns
        .map((turn, index) =>
          artifactByThread.get(turn.id) ??
          buildAssistantLessonPacket(
            {
              id: turn.id,
              userText: turn.userText,
              assistantText: turn.assistantText,
            },
            {
              includeProblem: index === 0,
              origin: {
                x: 120 + index * 1_800,
                y: index === 0 ? 80 : 120,
              },
            },
          ),
        )
        .filter((value): value is LessonPacketV1 => value !== null),
    [artifactByThread, conv.turns],
  );
  const packet = useMemo(
    () => mergeSessionBoardPackets(sessionId, turnPackets),
    [sessionId, turnPackets],
  );
  const deliveredOllEvents = useMemo(() => {
    const lessons: CanonicalEvent[][] = [];
    for (const artifact of ollArtifacts) {
      const events = loadedOllArtifacts[artifact.path];
      if (!events) break;
      lessons.push(events);
    }
    const events = composeOllClassroomEvents(lessons, sessionId);
    return events.length > 0 ? events : null;
  }, [loadedOllArtifacts, ollArtifacts, sessionId]);
  const lesson = useLessonPlayer(
    packet,
    !ollFixture && ollArtifacts.length === 0,
  );
  const activeOllEvents = ollFixture === "geometry-v2"
    ? geometryLessonEvents
    : deliveredOllEvents;
  const ollOpenSource = activeOllEvents?.[0]
    ? JSON.stringify(activeOllEvents[0])
    : null;
  const ollLesson = useOllLessonRuntime({
    source: ollOpenSource,
    storageKey: `octos-learning-oll:${sessionId}:${ollFixture ?? "none"}`,
    autoPlay: Boolean(activeOllEvents),
    incremental: Boolean(activeOllEvents),
  });
  const appendOllEvents = ollLesson?.appendEvents;

  useEffect(() => {
    if (!activeOllEvents || !appendOllEvents) return;
    let eventIndex = 1;
    let timer: number | undefined;
    const appendNext = () => {
      const event = activeOllEvents[eventIndex] as CanonicalEvent | undefined;
      if (!event) return;
      appendOllEvents([event]);
      eventIndex += 1;
      if (eventIndex < activeOllEvents.length) {
        timer = window.setTimeout(appendNext, 240);
      }
    };
    timer = window.setTimeout(appendNext, 240);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeOllEvents, appendOllEvents]);
  const boardContext = useMemo(
    () => buildLearningBoardContext(packet, lesson.segmentIndex),
    [lesson.segmentIndex, packet],
  );

  useEffect(() => {
    if (ollLesson) {
      onBoardContextChange?.({
        lastAppliedAction: ollLesson.currentOperation?.action?.action_id,
        boardSummary: `${ollLesson.title}；进度 ${ollLesson.cursor}/${ollLesson.totalOperations}`,
      });
      return;
    }
    onBoardContextChange?.(boardContext);
  }, [boardContext, ollLesson, onBoardContextChange]);

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

  const sendText = useCallback(
    async (text: string) => {
      setSendError(null);
      setTextTurnPending(true);
      onLearnerInput?.(text);
      const turnId = crypto.randomUUID();
      sendMessage({
        sessionId,
        text: buildTurnText(turnId, [], text),
        media: [],
        clientMessageId: turnId,
        onComplete: () => setTextTurnPending(false),
        onError: (error) => {
          setTextTurnPending(false);
          setSendError(error.message || "发送失败");
        },
      });
    },
    [buildTurnText, onLearnerInput, sessionId],
  );

  const sendImage = useCallback(
    async (file: File) => {
      setSendError(null);
      try {
        setTextTurnPending(true);
        const paths = await uploadFiles([file], "upload");
        const turnId = crypto.randomUUID();
        const prompt = "请看我上传的题目，把题目和关键步骤整理到白板上。";
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
          onComplete: () => setTextTurnPending(false),
          onError: (error) => {
            setTextTurnPending(false);
            setSendError(error.message || "图片发送失败");
          },
        });
      } catch (cause) {
        setTextTurnPending(false);
        setSendError(cause instanceof Error ? cause.message : "图片发送失败");
      }
    },
    [buildTurnText, onLearnerInput, sessionId],
  );

  const handleTeacherClick = () => {
    if (!voiceEnabled) {
      if (ollLesson) {
        if (ollLesson.playing) ollLesson.pause();
        else ollLesson.play();
      } else if (lesson.playing) lesson.pause();
      else lesson.play();
      return;
    }
    unlockAudio();
    if (conv.state === "speaking" || conv.state === "thinking") {
      conv.interrupt();
      lesson.pause();
      ollLesson?.pause();
      return;
    }
    if (conv.state === "idle" || conv.state === "error") {
      void conv.start();
    }
  };

  const latestAssistantText = conv.turns.at(-1)?.assistantText ?? "";
  const teacherSpeech = textTurnPending
    ? "我正在整理这道题，马上写到白板上。"
    : ollLesson?.activeSpeech
      ? ollLesson.activeSpeech
      : lesson.activeSpeech
        ? lesson.activeSpeech
        : conv.state === "speaking" && conv.lastAssistantText
          ? conv.lastAssistantText
          : latestAssistantText;

  return (
    <div className="learning-workspace">
      <header className="learning-workspace-topbar">
        <div>
          <span>Octos Learning Canvas</span>
          <strong>{ollLesson?.title ?? packet.title}</strong>
        </div>
        {ollLesson ? (
          <div className="learning-demo-controls" data-testid="oll-controls">
            <span>
              OLL · Beat {Math.max(0, ollLesson.beatIndex + 1)}/
              {ollLesson.beatCount}
            </span>
            <button
              type="button"
              onClick={ollLesson.playing ? ollLesson.pause : ollLesson.play}
              aria-label={ollLesson.playing ? "暂停 OLL 课程" : "播放 OLL 课程"}
              disabled={ollLesson.completed}
            >
              {ollLesson.playing ? <Pause size={17} /> : <Play size={17} />}
            </button>
            <button
              type="button"
              onClick={ollLesson.nextBeat}
              aria-label="下一 OLL Beat"
              disabled={ollLesson.completed}
            >
              <ChevronRight size={17} />
            </button>
            <button
              type="button"
              onClick={ollLesson.restart}
              aria-label="重新播放 OLL 课程"
            >
              <RotateCcw size={16} />
            </button>
          </div>
        ) : lesson.segmentCount > 0 ? (
          <div className="learning-demo-controls">
            <span>
              讲解 {Math.max(0, lesson.segmentIndex + 1)}/{lesson.segmentCount}
            </span>
            <button
              type="button"
              onClick={lesson.previous}
              aria-label="上一步"
              disabled={lesson.segmentIndex <= 0}
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={lesson.playing ? lesson.pause : lesson.play}
              aria-label={lesson.playing ? "暂停讲解" : "播放讲解"}
            >
              {lesson.playing ? <Pause size={17} /> : <Play size={17} />}
            </button>
            <button
              type="button"
              onClick={lesson.next}
              aria-label="下一步"
              disabled={lesson.segmentIndex >= lesson.segmentCount - 1}
            >
              <ChevronRight size={17} />
            </button>
            <button
              type="button"
              onClick={lesson.restart}
              aria-label="重新播放讲解"
            >
              <RotateCcw size={16} />
            </button>
          </div>
        ) : null}
        <div className="learning-workspace-actions">
          {voiceEnabled ? (
            <button
              type="button"
              className="learning-mode-button"
              onClick={onUseTextMode}
            >
              切换到文字
            </button>
          ) : (
            <span className="learning-mode-label">文字模式</span>
          )}
          <button
            type="button"
            className="learning-exit-button"
            onClick={onBack}
            aria-label="退出学习"
          >
            <X size={20} />
          </button>
        </div>
      </header>

      <main className="learning-canvas-shell">
        {ollLesson ? (
          <OllLessonBoard runtime={ollLesson} />
        ) : (
          <InfiniteBoard
            packet={packet}
            segmentIndex={lesson.segmentIndex}
          />
        )}
      </main>

      <OctosTeacher
        state={runtime.ready ? conv.state : "error"}
        speech={teacherSpeech}
        onClick={handleTeacherClick}
      />

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
        onMic={handleTeacherClick}
        onToggleCamera={conv.toggleCamera}
        onSendText={sendText}
        onSendImage={sendImage}
      />

      {(sendError || conv.error) && (
        <div className="learning-error" role="alert">
          {sendError ?? conv.error}
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
