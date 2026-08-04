import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalEvent } from "octos-lesson-language";
import { parseCanonicalJsonl } from "octos-lesson-language/web-runtime";
import {
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { uploadFiles } from "@/api/chat";
import { getSessionFiles } from "@/api/sessions";
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
import { InfiniteBoard } from "./board/infinite-board";
import { CameraSettingsDialog } from "./camera-settings-dialog";
import {
  mergeSessionBoardPackets,
  type LearningBoardContext,
} from "./board/session-board";
import geometryLessonSource from "./oll/fixtures/geometry-auxiliary-line-v2.canonical.jsonl?raw";
import { OllCourseOutline } from "./oll/oll-course-outline";
import { OllLessonBoard } from "./oll/oll-lesson-runtime";
import { useOllNarrationTts } from "./oll/use-oll-narration-tts";
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

function threadHasOllArtifact(threads: Thread[], turnId: string): boolean {
  const thread = threads.find((candidate) => candidate.id === turnId);
  if (!thread) return false;
  return [
    ...thread.responses,
    ...(thread.pendingAssistant ? [thread.pendingAssistant] : []),
  ].some((message) => message.files.some((file) =>
    file.path.toLowerCase().endsWith(".octos-lesson.json")
  ));
}

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
  const [narrationSpeechActive, setNarrationSpeechActive] = useState(false);
  const [completedTurnId, setCompletedTurnId] = useState<string | null>(null);
  const [plainReply, setPlainReply] = useState<{
    turnId: string;
    text: string;
  } | null>(null);
  const [plainReplySpoken, setPlainReplySpoken] = useState(false);
  const [pausedLessonSource, setPausedLessonSource] = useState<string | null>(null);
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
    narrationTiming: "external",
    startAtEnd: Boolean(activeOllEvents) && playbackMode === "review",
    topics: activeOllTopics,
  });
  // Audio ownership follows playback intent, not the current speech sample.
  // A live lesson claims the microphone on its first render and keeps it
  // through Beat/event gaps; only an explicit pause or completion releases it.
  const lessonOwnsNarration =
    playbackMode === "live" &&
    Boolean(ollLesson) &&
    !ollLesson?.completed &&
    pausedLessonSource !== ollOpenSource;
  const handleTurnComplete = useCallback((turnId: string) => {
    setPlainReply(null);
    setPlainReplySpoken(false);
    setCompletedTurnId(turnId);
    conversationOptions?.onTurnComplete?.(turnId);
  }, [conversationOptions]);
  const voiceConversationOptions = useMemo(
    () => ({
      ...conversationOptions,
      externalSpeechActive:
        voiceEnabled && (lessonOwnsNarration || narrationSpeechActive),
      onTurnComplete: handleTurnComplete,
    }),
    [
      conversationOptions,
      handleTurnComplete,
      lessonOwnsNarration,
      narrationSpeechActive,
      voiceEnabled,
    ],
  );
  const conv = useVoiceConversation(
    sessionId,
    undefined,
    onVoiceExit ?? onBack,
    voiceConversationOptions,
  );
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
        ollLesson.restart();
      },
      nextBeat: () => {
        claim();
        ollLesson.nextBeat();
      },
      playStep: (stepId: string) => {
        claim();
        ollLesson.playStep(stepId);
      },
      playBeat: (beatId: string) => {
        claim();
        ollLesson.playBeat(beatId);
      },
    };
  }, [ollLesson, ollOpenSource]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [fileListError, setFileListError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [textTurnPending, setTextTurnPending] = useState(false);
  const [narrationAudioEnabled, setNarrationAudioEnabled] = useState(true);
  const [cameraSettingsOpen, setCameraSettingsOpen] = useState(false);
  const [temporaryCameraPreview, setTemporaryCameraPreview] = useState(false);
  const temporaryCameraPreviewRef = useRef(false);
  const cameraPreviewRequestRef = useRef(0);
  const cameraSettings = conv.cameraSettings ?? DEFAULT_CAMERA_FRAME_SETTINGS;
  const startCamera = conv.startCamera;
  const stopCamera = conv.stopCamera;
  const completedArtifactFilename = completedTurnId
    ? `${completedTurnId}.octos-lesson.json`
    : null;
  const completedThreadHasArtifact = Boolean(
    completedTurnId && threadHasOllArtifact(threads, completedTurnId),
  );
  const completedTurnHasArtifact = Boolean(
    completedThreadHasArtifact || (
      completedArtifactFilename && ollArtifacts.some((artifact) =>
        artifact.filename.replaceAll("\\", "/").split("/").at(-1) === completedArtifactFilename
      )
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
    const artifactFilename = `${plainReply.turnId}.octos-lesson.json`;
    const threadHasArtifact = threadHasOllArtifact(threads, plainReply.turnId);
    if (threadHasArtifact || ollArtifacts.some((artifact) =>
      artifact.filename.replaceAll("\\", "/").split("/").at(-1) === artifactFilename
    )) {
      const timer = window.setTimeout(() => {
        setPlainReply(null);
        setPlainReplySpoken(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [ollArtifacts, plainReply, threads]);

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
    if (!voiceEnabled) {
      conv.stop();
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

  const ollNarrationActive = Boolean(
    ollLesson?.playing && ollLesson.activeSpeech.trim(),
  );
  const plainReplyNarrationId = plainReply && !plainReplySpoken && !lessonOwnsNarration
    ? `plain-reply:${plainReply.turnId}`
    : undefined;
  const completeOllNarration = ollLesson?.completeNarration;
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
    onSpeakingChange: setNarrationSpeechActive,
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

  const sendText = useCallback(
    async (text: string) => {
      unlockAudio();
      setSendError(null);
      setTextTurnPending(true);
      onLearnerInput?.(text);
      const turnId = crypto.randomUUID();
      sendMessage({
        sessionId,
        text: buildTurnText(turnId, [], text),
        media: [],
        clientMessageId: turnId,
        onComplete: () => {
          setTextTurnPending(false);
          handleTurnComplete(turnId);
        },
        onError: (error) => {
          setTextTurnPending(false);
          setSendError(error.message || "发送失败");
        },
      });
    },
    [buildTurnText, handleTurnComplete, onLearnerInput, sessionId],
  );

  const sendImage = useCallback(
    async (file: File) => {
      unlockAudio();
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
          onComplete: () => {
            setTextTurnPending(false);
            handleTurnComplete(turnId);
          },
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
    [buildTurnText, handleTurnComplete, onLearnerInput, sessionId],
  );

  const handleTeacherClick = () => {
    unlockAudio();
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
          : "无法启用麦克风和摄像头",
      );
    }
  };

  const closeCameraSettings = useCallback(() => {
    cameraPreviewRequestRef.current += 1;
    setCameraSettingsOpen(false);
    if (temporaryCameraPreviewRef.current) {
      temporaryCameraPreviewRef.current = false;
      setTemporaryCameraPreview(false);
      stopCamera();
    }
  }, [stopCamera]);

  const openCameraSettings = useCallback(async () => {
    setCameraSettingsOpen(true);
    if (conv.cameraActive || conv.cameraStream) return;
    const request = ++cameraPreviewRequestRef.current;
    const started = await startCamera();
    if (cameraPreviewRequestRef.current !== request) {
      if (started) stopCamera();
      return;
    }
    temporaryCameraPreviewRef.current = started;
    setTemporaryCameraPreview(started);
  }, [conv.cameraActive, conv.cameraStream, startCamera, stopCamera]);

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

  useEffect(() => () => {
    cameraPreviewRequestRef.current += 1;
    if (temporaryCameraPreviewRef.current) stopCamera();
  }, [stopCamera]);

  const teacherSpeech = lessonOwnsNarration
    ? ollLesson?.activeSpeech ?? ""
    : plainReply?.text ??
      (textTurnPending
        ? "我正在整理这道题，马上写到白板上。"
        : ollLesson
          ? ollLesson.activeSpeech ||
            (ollLesson.completed
              ? "这节课讲完了，你可以缩放白板回顾刚才的内容。"
              : "")
          : conv.state === "thinking"
            ? "我正在准备白板课程。"
            : "");

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
              onClick={() => {
                unlockAudio();
                if (controlledOllLesson?.playing) controlledOllLesson.pause();
                else controlledOllLesson?.play();
              }}
              aria-label={ollLesson.playing ? "暂停 OLL 课程" : "播放 OLL 课程"}
              disabled={ollLesson.completed}
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
              disabled={ollLesson.completed}
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
            className="learning-camera-calibration-button"
            onClick={() => void openCameraSettings()}
            aria-label="调整摄像头画面"
            aria-expanded={cameraSettingsOpen}
          >
            <Settings2 size={16} />
            <span>调整画面</span>
          </button>
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
              <CameraPreview
                stream={conv.cameraStream}
                settings={cameraSettings}
              />
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
          temporaryPreview={temporaryCameraPreview}
          onChange={conv.updateCameraSettings}
          onReset={conv.resetCameraSettings}
          onClose={closeCameraSettings}
        />
      )}

      <OctosTeacher
        state={runtime.ready ? conv.state : "error"}
        speech={teacherSpeech}
        onClick={handleTeacherClick}
      />

      {plainReply && (
        <div className="learning-turn-notice" role="status">
          本轮没有更新白板，当前画面仍是上一节课程。
        </div>
      )}
      {!plainReply && !completedTurnHasArtifact && (
        textTurnPending || conv.state === "thinking" || Boolean(completedTurnId)
      ) && (
        <div className="learning-turn-notice" role="status">
          正在处理本轮问题，白板暂未更新。
        </div>
      )}

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
        onMic={handleTeacherClick}
        onToggleCamera={conv.toggleCamera}
        onSendText={sendText}
        onSendImage={sendImage}
      />

      {(sendError ||
        fileListError ||
        artifactError ||
        conv.error ||
        ollNarrationTts.error) && (
        <div className="learning-error" role="alert">
          {sendError ??
            fileListError ??
            artifactError ??
            conv.error ??
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
