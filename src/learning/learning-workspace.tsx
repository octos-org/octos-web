import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalEvent } from "octos-lesson-language";
import { parseCanonicalJsonl } from "octos-lesson-language/web-runtime";
import {
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { uploadFiles } from "@/api/chat";
import { getSessionFiles } from "@/api/sessions";
import { sendMessage } from "@/runtime/ui-protocol-send";
import { unlockAudio } from "@/home/voice/audio-playback";
import { CameraPreview } from "@/home/voice/camera-preview";
import {
  useVoiceConversation,
  type VoiceConversationOptions,
  type VoiceConversationTurn,
} from "@/home/voice/use-voice-conversation";
import { useOminixRuntimeSummary } from "@/home/use-ominix-runtime-summary";
import { useRenderThreads } from "@/store/projection-render-adapter";
import { InfiniteBoard } from "./board/infinite-board";
import {
  mergeSessionBoardPackets,
  type LearningBoardContext,
} from "./board/session-board";
import geometryLessonSource from "./oll/fixtures/geometry-auxiliary-line-v2.canonical.jsonl?raw";
import { OllCourseOutline } from "./oll/oll-course-outline";
import { OllLessonBoard } from "./oll/oll-lesson-runtime";
import {
  buildOllLessonTopics,
  collectOllLessonArtifacts,
  collectPersistedOllLessonArtifacts,
  composeOllClassroomEvents,
  loadOllLessonArtifact,
  mergeOllLessonArtifacts,
  ollArtifactIdentity,
} from "./oll/oll-artifacts";
import { ollPlaybackStorageKey } from "./oll/oll-playback-storage";
import { useOllLessonRuntime } from "./oll/use-oll-lesson-runtime";
import { OctosTeacher } from "./octos-teacher";
import { StudentInputDock } from "./student-input-dock";
import "./learning-workspace.css";

const geometryLessonEvents = parseCanonicalJsonl(geometryLessonSource);

export interface LearningWorkspaceProps {
  sessionId: string;
  playbackMode?: "live" | "review";
  voiceEnabled?: boolean;
  onUseTextMode?: () => void;
  onUseVoiceMode?: () => Promise<void> | void;
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
  playbackMode = "live",
  voiceEnabled = true,
  onUseTextMode,
  onUseVoiceMode,
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
  const [loadedOllArtifacts, setLoadedOllArtifacts] = useState<
    Record<string, CanonicalEvent[]>
  >({});
  const [persistedOllArtifacts, setPersistedOllArtifacts] = useState<
    ReturnType<typeof collectPersistedOllLessonArtifacts>
  >([]);
  const [rejectedOllArtifactIds, setRejectedOllArtifactIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const ollArtifacts = useMemo(
    () => mergeOllLessonArtifacts(
      persistedOllArtifacts,
      collectOllLessonArtifacts(threads),
    ),
    [persistedOllArtifacts, threads],
  );
  const requestedOllArtifactsRef = useRef(new Set<string>());
  const ollArtifactRequestsRef = useRef(new Map<string, AbortController>());
  const [sendError, setSendError] = useState<string | null>(null);
  const [fileListError, setFileListError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [textTurnPending, setTextTurnPending] = useState(false);

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
    const handleBridgeConnected = () => {
      void loadPersistedArtifacts();
    };
    window.addEventListener("crew:bridge_connected", handleBridgeConnected);
    void loadPersistedArtifacts();
    return () => {
      cancelled = true;
      window.removeEventListener(
        "crew:bridge_connected",
        handleBridgeConnected,
      );
    };
  }, [ollFixture, sessionId]);

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
    const ollArtifactRequests = ollArtifactRequestsRef.current;
    return () => {
      for (const controller of ollArtifactRequests.values()) {
        controller.abort();
      }
      ollArtifactRequests.clear();
    };
  }, []);

  useEffect(() => {
    const pending = ollArtifacts.filter(
      (artifact) =>
        !requestedOllArtifactsRef.current.has(ollArtifactIdentity(artifact)),
    );
    if (pending.length === 0) return;
    pending.forEach((artifact) => {
      const artifactIdentity = ollArtifactIdentity(artifact);
      const controller = new AbortController();
      requestedOllArtifactsRef.current.add(artifactIdentity);
      ollArtifactRequestsRef.current.set(artifactIdentity, controller);
      loadOllLessonArtifact(artifact, sessionId, controller.signal)
        .then((events) => {
          setLoadedOllArtifacts((current) => ({
            ...current,
            [artifactIdentity]: events,
          }));
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

  const emptyPacket = useMemo(
    () => mergeSessionBoardPackets(sessionId, []),
    [sessionId],
  );
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
  const activeOllEvents = ollFixture === "geometry-v2"
    ? geometryLessonEvents
    : deliveredOllEvents;
  const activeOllTopics = useMemo(
    () => buildOllLessonTopics(
      ollFixture === "geometry-v2"
        ? [geometryLessonEvents]
        : deliveredOllLessons,
    ),
    [deliveredOllLessons, ollFixture],
  );
  const ollOpenSource = activeOllEvents?.[0]
    ? JSON.stringify(activeOllEvents[0])
    : null;
  const ollLesson = useOllLessonRuntime({
    source: ollOpenSource,
    storageKey: ollPlaybackStorageKey(sessionId, ollFixture),
    autoPlay: Boolean(activeOllEvents) && playbackMode === "live",
    incremental: Boolean(activeOllEvents),
    startAtEnd: Boolean(activeOllEvents) && playbackMode === "review",
    topics: activeOllTopics,
  });
  const appendOllEvents = ollLesson?.appendEvents;
  const appendedOllEventCountRef = useRef(1);

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
      }
      return;
    }
    unlockAudio();
    if (conv.state === "speaking" || conv.state === "thinking") {
      conv.interrupt();
      ollLesson?.pause();
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
          : "无法启用麦克风和摄像头",
      );
    }
  };

  const teacherSpeech = textTurnPending
    ? "我正在整理这道题，马上写到白板上。"
    : ollLesson
      ? ollLesson.activeSpeech || (ollLesson.completed
        ? "这节课讲完了，你可以缩放白板回顾刚才的内容。"
        : "")
      : conv.state === "thinking"
        ? "我正在准备白板课程。"
        : "";

  return (
    <div className="learning-workspace">
      <header className="learning-workspace-topbar">
        <div>
          <span>Octos Learning Canvas</span>
          <strong>{ollLesson?.title ?? emptyPacket.title}</strong>
        </div>
        {ollLesson ? (
          <div className="learning-demo-controls" data-testid="oll-controls">
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
            <button
              type="button"
              className="learning-mode-button"
              onClick={() => void handleUseVoiceMode()}
            >
              启用语音和摄像头
            </button>
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
            packet={emptyPacket}
            segmentIndex={-1}
          />
        )}
      </main>

      {voiceEnabled && (conv.cameraStream || conv.lastSentFrameUrl) && (
        <div className="learning-camera-monitor" aria-label="摄像头画面">
          {conv.cameraStream && (
            <div className="learning-camera-frame">
              <CameraPreview stream={conv.cameraStream} />
              <span>台灯画面</span>
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

      <OctosTeacher
        state={runtime.ready ? conv.state : "error"}
        speech={teacherSpeech}
        onClick={handleTeacherClick}
      />

      {ollLesson ? <OllCourseOutline runtime={ollLesson} /> : null}

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

      {(sendError || fileListError || artifactError || conv.error) && (
        <div className="learning-error" role="alert">
          {sendError ?? fileListError ?? artifactError ?? conv.error}
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
