import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, BookOpen, Menu, Pencil, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  deleteSession,
  getSessionFiles,
  listSessions,
  setSessionTitle,
} from "@/api/sessions";
import { UiProtocolQuestionHost } from "@/components/ui-protocol-question-host";
import { ScopedRuntimeBridge } from "@/runtime/runtime-provider";
import {
  SessionContext,
  useModeState,
  type AdaptiveMode,
  type QueueMode,
} from "@/runtime/session-context";
import { unlockAudio } from "@/home/voice/audio-playback";
import { useWakeLock } from "@/home/use-wake-lock";
import {
  getMyProfileSkills,
  type SkillInfo,
} from "@/settings/settings-api";
import type {
  VoiceConversationOptions,
  VoiceConversationTurn,
} from "@/home/voice/use-voice-conversation";
import {
  buildLearningSessionContext,
  buildLearningTurnContext,
  stripLearningContext,
} from "./learning-context";
import { LearningWorkspace } from "./learning-workspace";
import type { LearningBoardContext } from "./board/session-board";
import {
  createProvisionalLearningSession,
  adoptLearningSession,
  isSubstantiveLearningText,
  listLearningSessions,
  promoteLearningSession,
  removeLearningSession,
  resolveLearningEntrySession,
  updateLearningSession,
  type LearningSessionRecord,
} from "./learning-session-store";
import { isOllLessonArtifact } from "./oll/oll-artifacts";
import { consumeWakeAudio } from "./wake-audio-handoff";
import {
  acquireLearningTabLease,
  getLearningTabOwner,
  releaseLearningTabLease,
  renewLearningTabLease,
} from "./learning-tab-lease";

const AUTO_CAMERA_KEY = "octos_learning_auto_camera";
const INPUT_MODE_KEY = "octos_learning_input_mode";
// 0.8.4 isolates standalone, current-image, and explicit board-follow-up
// requests so prior board content cannot fill a different or ambiguous task.
const MINIMUM_WHITEBOARD_SKILL_VERSION = [0, 8, 4] as const;
const LEARNING_TAB_ID = getLearningTabOwner();

type LearningMediaCapability =
  | { available: true }
  | { available: false; message: string };

function detectLearningMediaCapability(): LearningMediaCapability {
  if (window.isSecureContext === false) {
    return {
      available: false,
      message:
        "当前页面不是安全连接，浏览器已停用麦克风和摄像头。请使用 HTTPS 地址；同一台电脑也可以使用 http://localhost:5173/learn。",
    };
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
    return {
      available: false,
      message:
        "当前浏览器无法访问麦克风和摄像头。请确认浏览器支持媒体设备，并检查系统或浏览器权限设置。",
    };
  }
  return { available: true };
}

function describeLearningDeviceError(cause: unknown): string {
  if (cause instanceof DOMException) {
    if (cause.name === "NotAllowedError" || cause.name === "SecurityError") {
      return "麦克风或摄像头权限被拒绝。请在浏览器的网站设置中允许访问后重试。";
    }
    if (cause.name === "NotFoundError" || cause.name === "DevicesNotFoundError") {
      return "没有找到可用的麦克风或摄像头。请连接设备后重试。";
    }
    if (cause.name === "NotReadableError" || cause.name === "TrackStartError") {
      return "麦克风或摄像头正被其他应用占用，或暂时无法读取。";
    }
  }
  return cause instanceof Error ? cause.message : "设备授权失败";
}

async function requestLearningDevices(autoCamera: boolean): Promise<{
  autoCamera: boolean;
  voiceEnabled: boolean;
}> {
  const capability = detectLearningMediaCapability();
  if (!capability.available) throw new Error(capability.message);
  unlockAudio();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: autoCamera,
  });
  stream.getTracks().forEach((track) => track.stop());
  localStorage.setItem(AUTO_CAMERA_KEY, String(autoCamera));
  localStorage.setItem(INPUT_MODE_KEY, "voice");
  return { autoCamera, voiceEnabled: true };
}

function supportsWhiteboardProtocol(skill: SkillInfo): boolean {
  if (skill.name !== "learning-coach" || !skill.version) return false;
  const version = skill.version
    .split("-", 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (version.length < 3 || version.some((part) => !Number.isFinite(part))) {
    return false;
  }
  for (let index = 0; index < MINIMUM_WHITEBOARD_SKILL_VERSION.length; index += 1) {
    if (version[index] > MINIMUM_WHITEBOARD_SKILL_VERSION[index]) return true;
    if (version[index] < MINIMUM_WHITEBOARD_SKILL_VERSION[index]) return false;
  }
  return true;
}

function LearningPermissionGate({
  onReady,
}: {
  onReady: (preferences: {
    autoCamera: boolean;
    voiceEnabled: boolean;
  }) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const capability = detectLearningMediaCapability();
  const capabilityMessage = capability.available ? null : capability.message;

  const activate = async (autoCamera: boolean) => {
    if (capabilityMessage) {
      setError(capabilityMessage);
      return;
    }
    try {
      onReady(await requestLearningDevices(autoCamera));
    } catch (cause) {
      setError(describeLearningDeviceError(cause));
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-black px-6 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        <BookOpen className="mx-auto mb-5 text-cyan-300" size={36} />
        <h1 className="text-2xl font-semibold">启用小章鱼学习助手</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">
          可以启用语音和摄像头，也可以直接用文字试用白板。
          摄像头模式每次说话只会发送当下的一帧画面。
        </p>
        <button
          type="button"
          onClick={() => void activate(true)}
          disabled={!capability.available}
          className="mt-7 w-full rounded-full bg-cyan-300 px-5 py-3 font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          启用语音和摄像头
        </button>
        <button
          type="button"
          onClick={() => void activate(false)}
          disabled={!capability.available}
          className="mt-3 w-full rounded-full border border-white/15 px-5 py-3 text-white/75 disabled:cursor-not-allowed disabled:opacity-40"
        >
          仅启用语音
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(AUTO_CAMERA_KEY, "false");
            localStorage.setItem(INPUT_MODE_KEY, "text");
            onReady({ autoCamera: false, voiceEnabled: false });
          }}
          className="mt-3 w-full rounded-full border border-cyan-200/20 px-5 py-3 text-cyan-100/80"
        >
          仅用文字进入白板
        </button>
        {(error || capabilityMessage) && (
          <p className="mt-4 text-sm leading-5 text-red-300" role="alert">
            {error ?? capabilityMessage}
          </p>
        )}
      </div>
    </div>
  );
}

function LearningSessionScope({
  record,
  children,
}: {
  record: LearningSessionRecord;
  children: ReactNode;
}) {
  const { queueMode, adaptiveMode } = useModeState(record.id);
  const [activeTask, setActiveTask] = useState(false);
  const setServerTaskActive = useCallback(
    (_sessionId: string, active: boolean) => setActiveTask(active),
    [],
  );
  const sessionValue = useMemo(
    () => ({
      sessions: [],
      currentSessionId: record.id,
      historyTopic: "",
      currentSessionTitle: record.title,
      currentSessionStats: null,
      activeTaskOnServer: activeTask,
      queueMode: queueMode as QueueMode,
      adaptiveMode: adaptiveMode as AdaptiveMode,
      setServerTaskActive,
      renameSession: () => {},
      updateSessionStats: () => {},
      switchSession: () => {},
      goBack: async () => false,
      createSession: () => record.id,
      removeSession: async () => {},
      branchSession: async () => {
        throw new Error("session fork is not available on this surface");
      },
      refreshSessions: async () => {},
      markSessionActive: () => {},
    }),
    [
      activeTask,
      adaptiveMode,
      queueMode,
      record.id,
      record.title,
      setServerTaskActive,
    ],
  );

  return (
    <SessionContext.Provider value={sessionValue}>
      <ScopedRuntimeBridge>{children}</ScopedRuntimeBridge>
    </SessionContext.Provider>
  );
}

function sessionTimestamp(sessionId: string): number {
  const value = Number(/^learn-(\d+)/.exec(sessionId)?.[1]);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function LearningServerSync({
  onDone,
}: {
  onDone: (
    discovered: LearningSessionRecord[],
    authoritative: boolean,
  ) => void;
}) {
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;

    const sync = async () => {
      attempts += 1;
      try {
        const allServerSessions = await listSessions();
        const learningSessions = allServerSessions.filter((session) =>
          session.id.startsWith("learn-"),
        );
        const validatedSessions = await Promise.all(
          learningSessions.map(async (session) => ({
            session,
            files: await getSessionFiles(session.id),
          })),
        );
        const serverSessions = validatedSessions
          .filter(({ files }) => files.some(isOllLessonArtifact))
          .map(({ session }) => session);
        const discovered: LearningSessionRecord[] = [];
        for (const session of serverSessions) {
          const createdAt = sessionTimestamp(session.id);
          const serverTitle = stripLearningContext(session.title ?? "");
          const usableServerTitle =
            serverTitle &&
            !serverTitle.startsWith("[[LEARNING_") &&
            isSubstantiveLearningText(serverTitle)
              ? serverTitle
              : null;
          const record: LearningSessionRecord = {
            id: session.id,
            status: "paused",
            title: usableServerTitle ?? "已保存的学习",
            createdAt,
            updatedAt: createdAt,
          };
          discovered.push(record);
        }
        if (!cancelled) onDone(discovered, true);
      } catch {
        if (cancelled) return;
        if (attempts < 4) {
          timer = window.setTimeout(() => void sync(), 300);
        } else {
          onDone([], false);
        }
      }
    };

    void sync();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onDone]);
  return null;
}

export function LearningPage() {
  const navigate = useNavigate();
  // Keep the screen on during lessons (long narration + no interaction;
  // audit L7 — only /home held a wake lock before).
  useWakeLock();
  const ollFixture = useMemo<"geometry-v2" | undefined>(() => {
    const requested = new URLSearchParams(window.location.search).get(
      "oll-fixture",
    );
    return requested === "geometry-v2" ? requested : undefined;
  }, []);
  const [hasTabLease] = useState(() =>
    acquireLearningTabLease(LEARNING_TAB_ID),
  );

  // Auto-recover from the lease-blocked dead screen (audit L8): once
  // the other tab closes, its lease expires within the TTL and this
  // poll acquires it — then reload to boot the real workspace. A live
  // owner renews every 5s against a 15s TTL, so we can never steal it.
  useEffect(() => {
    if (hasTabLease) return;
    const id = window.setInterval(() => {
      if (acquireLearningTabLease(LEARNING_TAB_ID)) {
        window.location.reload();
      }
    }, 4000);
    return () => window.clearInterval(id);
  }, [hasTabLease]);
  const wakeAudio = useMemo(() => consumeWakeAudio(), []);
  const [initialEntry] = useState(() => {
    if (!hasTabLease) {
      return {
        record: {
          id: "learn-blocked",
          status: "provisional" as const,
          title: "学习助手已在另一个标签页中打开",
          createdAt: 0,
          updatedAt: 0,
        },
      };
    }
    const hadResumableSession = listLearningSessions().some(
      (session) => session.status === "active" || session.status === "paused",
    );
    const resolved = resolveLearningEntrySession();
    const record =
      resolved.status === "paused"
        ? updateLearningSession(resolved.id, { status: "active" }) ?? resolved
        : resolved;
    return {
      hadResumableSession,
      record,
    };
  });
  const [record, setRecord] = useState<LearningSessionRecord>(
    initialEntry.record,
  );
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(() =>
    initialEntry.record.status === "provisional"
      ? null
      : initialEntry.record.id,
  );
  const recordRef = useRef(record);
  useEffect(() => {
    recordRef.current = record;
  }, [record]);
  const boardContextRef = useRef<LearningBoardContext>({});
  const [sessions, setSessions] = useState(() => listLearningSessions());
  const [devicePreferences, setDevicePreferences] = useState<{
    autoCamera: boolean;
    voiceEnabled: boolean;
  } | null>(() => {
    if (ollFixture) return { autoCamera: false, voiceEnabled: false };
    const storedCamera = localStorage.getItem(AUTO_CAMERA_KEY);
    const storedMode = localStorage.getItem(INPUT_MODE_KEY);
    if (storedCamera === null && storedMode === null) return null;
    const voiceEnabled = storedMode !== "text";
    if (voiceEnabled && !detectLearningMediaCapability().available) return null;
    return {
      autoCamera: storedCamera === "true",
      voiceEnabled,
    };
  });
  const [skillState, setSkillState] = useState<
    "checking" | "ready" | "missing" | "outdated" | "error"
  >(ollFixture ? "ready" : "checking");
  // Bumped by the gate's "重新检查" button to re-run the skill probe without
  // a full page reload.
  const [skillCheckTick, setSkillCheckTick] = useState(0);
  const [serverSyncReady, setServerSyncReady] = useState(Boolean(ollFixture));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const markerSentRef = useRef(false);
  const [wakeSessionId, setWakeSessionId] = useState<string | null>(
    wakeAudio ? record.id : null,
  );

  const refreshLocalSessions = useCallback(() => {
    setSessions(listLearningSessions());
  }, []);

  const handleServerSync = useCallback(
    (
      discovered: LearningSessionRecord[],
      authoritative: boolean,
    ) => {
      if (!authoritative) {
        setServerSyncReady(true);
        return;
      }

      const adopted = discovered.map((session) => adoptLearningSession(session));
      const keepIds = new Set(adopted.map((session) => session.id));
      for (const local of listLearningSessions()) {
        if (!keepIds.has(local.id)) removeLearningSession(local.id);
      }

      const current = recordRef.current;
      const currentWasRemoved =
        current.status !== "provisional" && !keepIds.has(current.id);
      if (
        (currentWasRemoved ||
          (!initialEntry.hadResumableSession && current.status === "provisional")) &&
        adopted.length > 0
      ) {
        const latest = [...adopted].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        )[0];
        if (current.id !== latest.id) removeLearningSession(current.id);
        const resumed =
          updateLearningSession(latest.id, { status: "active" }) ??
          adoptLearningSession({ ...latest, status: "active" });
        markerSentRef.current = false;
        boardContextRef.current = {};
        setReviewSessionId(resumed.id);
        setWakeSessionId(wakeAudio ? resumed.id : null);
        setRecord(resumed);
      } else if (currentWasRemoved) {
        const next = createProvisionalLearningSession();
        markerSentRef.current = false;
        boardContextRef.current = {};
        setReviewSessionId(null);
        setWakeSessionId(null);
        setRecord(next);
      }
      refreshLocalSessions();
      setServerSyncReady(true);
    },
    [
      initialEntry.hadResumableSession,
      refreshLocalSessions,
      wakeAudio,
    ],
  );

  useEffect(() => {
    if (!hasTabLease) return;
    const timer = window.setInterval(() => {
      renewLearningTabLease(LEARNING_TAB_ID);
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      releaseLearningTabLease(LEARNING_TAB_ID);
    };
  }, [hasTabLease]);

  useEffect(() => {
    if (!hasTabLease || ollFixture) return;
    let cancelled = false;
    getMyProfileSkills()
      .then((skills) => {
        if (cancelled) return;
        const coach = skills.find((skill) => skill.name === "learning-coach");
        setSkillState(
          !coach
            ? "missing"
            : supportsWhiteboardProtocol(coach)
              ? "ready"
              : "outdated",
        );
      })
      .catch(() => {
        if (!cancelled) setSkillState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [hasTabLease, ollFixture, skillCheckTick]);

  const recheckSkill = useCallback(() => {
    setSkillState("checking");
    setSkillCheckTick((tick) => tick + 1);
  }, []);

  const buildTurnText = useCallback<NonNullable<VoiceConversationOptions["buildTurnText"]>>(
    (context) => {
      const turnContext = buildLearningTurnContext({
        sessionId: record.id,
        turnId: context.turnId,
        provisional:
          record.status === "provisional" ? true : undefined,
        currentFrame: context.currentFramePath,
        lastAppliedAction: boardContextRef.current.lastAppliedAction,
        boardSummary: boardContextRef.current.boardSummary,
      });
      if (!markerSentRef.current) {
        markerSentRef.current = true;
        const sessionContext = buildLearningSessionContext({
          sessionId: record.id,
          entry:
            wakeSessionId === record.id ? "wake-word" : "direct",
          provisional: record.status === "provisional",
        });
        return `${sessionContext}\n${turnContext}`;
      }
      return turnContext;
    },
    [record.id, record.status, wakeSessionId],
  );

  const conversationOptions = useMemo<VoiceConversationOptions>(
    () => ({
      autoStartCamera:
        devicePreferences?.voiceEnabled === true &&
        devicePreferences.autoCamera,
      buildTurnText,
      playReplyAudio: false,
      showExistingTurns: true,
      onTurnStart: () => {
        setReviewSessionId((current) =>
          current === record.id ? null : current,
        );
      },
    }),
    [buildTurnText, devicePreferences, record.id],
  );

  const handleBoardContextChange = useCallback(
    (context: LearningBoardContext) => {
      boardContextRef.current = context;
    },
    [],
  );

  const useTextMode = useCallback(() => {
    localStorage.setItem(AUTO_CAMERA_KEY, "false");
    localStorage.setItem(INPUT_MODE_KEY, "text");
    setDevicePreferences({ autoCamera: false, voiceEnabled: false });
  }, []);

  const useVoiceAndCameraMode = useCallback(async () => {
    const preferences = await requestLearningDevices(true);
    setDevicePreferences(preferences);
  }, []);

  const handleLearnerInput = useCallback(
    (text: string) => {
      setReviewSessionId((current) =>
        current === record.id ? null : current,
      );
      if (record.status !== "provisional") return;
      if (!isSubstantiveLearningText(text)) return;
      const promoted = promoteLearningSession(record.id, text);
      if (!promoted) return;
      setRecord(promoted);
      refreshLocalSessions();
      void setSessionTitle(promoted.id, promoted.title).catch(() => {
        // Local title remains usable when an older server cannot persist it.
      });
    },
    [record.id, record.status, refreshLocalSessions],
  );

  const handleTurnsChange = useCallback(
    (turns: VoiceConversationTurn[]) => {
      const substantive = turns.find((turn) =>
        isSubstantiveLearningText(turn.userText),
      );
      if (substantive) handleLearnerInput(substantive.userText);
    },
    [handleLearnerInput],
  );

  const leave = useCallback(() => {
    if (record.status === "provisional") {
      void deleteSession(record.id).catch(() => undefined);
      removeLearningSession(record.id);
    } else if (record.status === "active") {
      updateLearningSession(record.id, { status: "paused" });
    }
    navigate("/");
  }, [navigate, record.id, record.status]);

  const finishAndLeave = useCallback(() => {
    if (record.status === "provisional") {
      void deleteSession(record.id).catch(() => undefined);
      removeLearningSession(record.id);
    } else {
      updateLearningSession(record.id, { status: "completed" });
    }
    navigate("/");
  }, [navigate, record.id, record.status]);

  const switchTo = useCallback((next: LearningSessionRecord) => {
    if (record.status === "active") {
      updateLearningSession(record.id, { status: "paused" });
    }
    const resumed =
      next.status === "provisional" || next.status === "active"
        ? next
        : updateLearningSession(next.id, { status: "active" }) ?? next;
    markerSentRef.current = false;
    boardContextRef.current = {};
    setReviewSessionId(next.id);
    setWakeSessionId(null);
    setRecord(resumed);
    refreshLocalSessions();
    setSidebarOpen(false);
  }, [record.id, record.status, refreshLocalSessions]);

  const newSession = useCallback(() => {
    if (record.status === "provisional") {
      void deleteSession(record.id).catch(() => undefined);
      removeLearningSession(record.id);
    } else if (record.status === "active") {
      updateLearningSession(record.id, { status: "paused" });
    }
    const next = createProvisionalLearningSession();
    markerSentRef.current = false;
    boardContextRef.current = {};
    setReviewSessionId(null);
    setWakeSessionId(null);
    setRecord(next);
    refreshLocalSessions();
    setSidebarOpen(false);
  }, [record.id, record.status, refreshLocalSessions]);

  const remove = useCallback(
    (session: LearningSessionRecord) => {
      if (!window.confirm(`删除“${session.title}”？此操作会删除这段学习对话。`)) {
        return;
      }
      void deleteSession(session.id)
        .catch(() => undefined)
        .finally(() => {
          removeLearningSession(session.id);
          if (record.id === session.id) {
            const next = resolveLearningEntrySession();
            markerSentRef.current = false;
            boardContextRef.current = {};
            setReviewSessionId(
              next.status === "provisional" ? null : next.id,
            );
            setWakeSessionId(null);
            setRecord(next);
          }
          refreshLocalSessions();
        });
    },
    [record.id, refreshLocalSessions],
  );

  const rename = useCallback(
    (session: LearningSessionRecord) => {
      const title = window.prompt("重命名学习会话", session.title)?.trim();
      if (!title || title === session.title) return;
      const updated = updateLearningSession(session.id, { title });
      if (!updated) return;
      if (record.id === session.id) setRecord(updated);
      refreshLocalSessions();
      void setSessionTitle(session.id, title).catch(() => undefined);
    },
    [record.id, refreshLocalSessions],
  );

  if (!hasTabLease) {
    return (
      <div className="relative flex h-screen w-screen items-center justify-center bg-black px-6 text-white">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="absolute left-5 top-6 flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm text-white/60 transition hover:border-white/30 hover:text-white"
        >
          <ArrowLeft size={16} />
          返回首页
        </button>
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">学习助手已在另一个标签页中使用</h1>
          <p className="mt-3 text-sm leading-6 text-white/55">
            为避免两个页面同时占用麦克风，请先关闭另一个学习页。关闭后本页会在数秒内自动恢复。
          </p>
        </div>
      </div>
    );
  }

  if (skillState !== "ready") {
    return (
      <div className="relative flex h-screen w-screen items-center justify-center bg-black px-6 text-white">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="absolute left-5 top-6 flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm text-white/60 transition hover:border-white/30 hover:text-white"
        >
          <ArrowLeft size={16} />
          返回首页
        </button>
        <div className="w-full max-w-md text-center">
          <BookOpen className="mx-auto mb-5 text-cyan-300" size={36} />
          <h1 className="text-xl font-semibold">
            {skillState === "checking"
              ? "正在检查学习教练…"
              : skillState === "missing"
                ? "需要安装 learning-coach Skill"
                : skillState === "outdated"
                  ? "learning-coach 版本过旧"
                  : "暂时无法确认 learning-coach Skill"}
          </h1>
          {skillState !== "checking" && (
            <>
              <p className="mt-3 text-sm leading-6 text-white/55">
                {skillState === "outdated"
                  ? "学习课堂需要 learning-coach 0.8.4 或更高版本。更新后回到这里重新检查；如提示需重启 Gateway，按提示操作即可。"
                  : skillState === "missing"
                    ? "学习课堂由 learning-coach 教学技能驱动。前往 设置 → Skills 安装后回到这里重新检查；如提示需重启 Gateway，按提示操作即可。"
                    : "可能是网络或服务暂时不可用，请稍后重新检查。"}
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                {(skillState === "missing" || skillState === "outdated") && (
                  <button
                    type="button"
                    onClick={() => navigate("/settings?tab=skills")}
                    className="rounded-full bg-white px-5 py-3 text-sm font-medium text-black"
                  >
                    打开 Skill 设置
                  </button>
                )}
                <button
                  type="button"
                  onClick={recheckSkill}
                  className="rounded-full border border-white/20 px-5 py-3 text-sm font-medium text-white/80 transition hover:border-white/40 hover:text-white"
                >
                  重新检查
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (devicePreferences === null) {
    return <LearningPermissionGate onReady={setDevicePreferences} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-black text-white">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭学习会话列表"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-20 bg-black/35 backdrop-blur-[2px]"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 shrink-0 flex-col border-r border-white/10 bg-zinc-950 p-4 shadow-2xl transition-transform ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          type="button"
          onClick={newSession}
          className="flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-medium text-black"
        >
          <Plus size={16} />
          新对话
        </button>
        <div className="mt-5 flex-1 space-y-1 overflow-y-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-center rounded-xl ${
                session.id === record.id ? "bg-white/10" : "hover:bg-white/5"
              }`}
            >
              <button
                type="button"
                aria-label={`重命名 ${session.title}`}
                onClick={() => rename(session)}
                // Always visible: hover-only controls are unreachable on
                // touch devices (2026-08 UI audit M4).
                className="p-1 text-white/30 transition hover:text-white/80"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => switchTo(session)}
                className="min-w-0 flex-1 truncate px-3 py-3 text-left text-sm text-white/75"
              >
                {session.title}
              </button>
              <button
                type="button"
                aria-label={`删除 ${session.title}`}
                onClick={() => remove(session)}
                className="mr-2 p-1 text-white/30 transition hover:text-white/80"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="truncate border-t border-white/10 pt-3 text-xs text-white/40">
          {record.title}
        </div>
      </aside>

      <main className="relative min-w-0 flex-1">
        <button
          type="button"
          aria-label="打开学习会话列表"
          onClick={() => setSidebarOpen(true)}
          className="learning-sidebar-toggle absolute left-5 top-6 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white/80 text-stone-600 shadow-sm backdrop-blur-md hover:text-cyan-800"
        >
          <Menu size={20} />
        </button>
        <LearningSessionScope record={record}>
          {!ollFixture && <LearningServerSync onDone={handleServerSync} />}
          {serverSyncReady ? (
            <LearningWorkspace
              key={record.id}
              sessionId={record.id}
              playbackMode={
                reviewSessionId === record.id ? "review" : "live"
              }
              initialAudio={
                wakeSessionId === record.id ? wakeAudio : null
              }
              conversationOptions={conversationOptions}
              voiceEnabled={devicePreferences.voiceEnabled}
              onUseTextMode={useTextMode}
              onUseVoiceMode={useVoiceAndCameraMode}
              onLearnerInput={handleLearnerInput}
              onTurnsChange={handleTurnsChange}
              onBoardContextChange={handleBoardContextChange}
              onBack={leave}
              onVoiceExit={finishAndLeave}
              ollFixture={ollFixture}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-white/45">
              正在恢复学习会话…
            </div>
          )}
          <UiProtocolQuestionHost />
        </LearningSessionScope>
      </main>
    </div>
  );
}
