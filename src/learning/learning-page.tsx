import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BookOpen, Menu, Pencil, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  deleteSession,
  getMessages,
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
import { VoiceView } from "@/home/voice/voice-view";
import { getMyProfileSkills } from "@/settings/settings-api";
import type {
  VoiceConversationOptions,
  VoiceConversationTurn,
} from "@/home/voice/use-voice-conversation";
import {
  buildLearningSessionContext,
  buildLearningTurnContext,
  stripLearningContext,
} from "./learning-context";
import {
  cleanupProvisionalLearningSessions,
  createProvisionalLearningSession,
  adoptLearningSession,
  isSubstantiveLearningText,
  listLearningSessions,
  promoteLearningSession,
  removeLearningSession,
  resolveLearningEntrySession,
  titleFromLearningText,
  updateLearningSession,
  type LearningSessionRecord,
} from "./learning-session-store";
import { consumeWakeAudio } from "./wake-audio-handoff";
import {
  acquireLearningTabLease,
  releaseLearningTabLease,
  renewLearningTabLease,
} from "./learning-tab-lease";

const AUTO_CAMERA_KEY = "octos_learning_auto_camera";
const PROVISIONAL_TIMEOUT_MS = 2 * 60 * 1000;
const LEARNING_TAB_ID =
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `learning-tab-${Math.random().toString(36).slice(2)}`;

function LearningPermissionGate({
  onReady,
}: {
  onReady: (autoCamera: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const activate = async (autoCamera: boolean) => {
    try {
      unlockAudio();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: autoCamera,
      });
      stream.getTracks().forEach((track) => track.stop());
      localStorage.setItem(AUTO_CAMERA_KEY, String(autoCamera));
      onReady(autoCamera);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "设备授权失败");
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-black px-6 text-white">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        <BookOpen className="mx-auto mb-5 text-cyan-300" size={36} />
        <h1 className="text-2xl font-semibold">启用小章鱼学习助手</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">
          首次使用需要解锁语音。你也可以允许学习时自动打开摄像头，
          每次说话只会发送当下的一帧画面。
        </p>
        <button
          type="button"
          onClick={() => void activate(true)}
          className="mt-7 w-full rounded-full bg-cyan-300 px-5 py-3 font-medium text-black"
        >
          启用语音和摄像头
        </button>
        <button
          type="button"
          onClick={() => void activate(false)}
          className="mt-3 w-full rounded-full border border-white/15 px-5 py-3 text-white/75"
        >
          仅启用语音
        </button>
        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
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

function OrphanSessionCleanup({ sessionIds }: { sessionIds: string[] }) {
  useEffect(() => {
    if (sessionIds.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const sessionId of sessionIds) {
        void deleteSession(sessionId).catch(() => undefined);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [sessionIds]);
  return null;
}

function sessionTimestamp(sessionId: string): number {
  const value = Number(/^learn-(\d+)/.exec(sessionId)?.[1]);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function LearningServerSync({
  onDone,
}: {
  onDone: (discovered: LearningSessionRecord[]) => void;
}) {
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;

    const sync = async () => {
      attempts += 1;
      try {
        const localIds = new Set(
          listLearningSessions({ includeProvisional: true }).map(
            (session) => session.id,
          ),
        );
        const serverSessions = (await listSessions()).filter(
          (session) =>
            session.id.startsWith("learn-") && !localIds.has(session.id),
        );
        const discovered: LearningSessionRecord[] = [];
        for (const session of serverSessions) {
          const messages = await getMessages(session.id, 100);
          const firstSubstantive = messages
            .filter((message) => message.role === "user")
            .map((message) => ({
              message,
              text: stripLearningContext(message.content),
            }))
            .find(({ text }) => isSubstantiveLearningText(text));
          if (!firstSubstantive) {
            void deleteSession(session.id).catch(() => undefined);
            continue;
          }
          const createdAt = sessionTimestamp(session.id);
          const updatedAt = messages.reduce((latest, message) => {
            const timestamp = new Date(message.timestamp).getTime();
            return Number.isFinite(timestamp)
              ? Math.max(latest, timestamp)
              : latest;
          }, createdAt);
          const serverTitle = stripLearningContext(session.title ?? "");
          const record = adoptLearningSession({
            id: session.id,
            status: "paused",
            title:
              serverTitle && isSubstantiveLearningText(serverTitle)
                ? serverTitle
                : titleFromLearningText(firstSubstantive.text),
            createdAt,
            updatedAt,
          });
          discovered.push(record);
        }
        if (!cancelled) onDone(discovered);
      } catch {
        if (cancelled) return;
        if (attempts < 4) {
          timer = window.setTimeout(() => void sync(), 300);
        } else {
          onDone([]);
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
  const [hasTabLease] = useState(() =>
    acquireLearningTabLease(LEARNING_TAB_ID),
  );
  const wakeAudio = useMemo(() => consumeWakeAudio(), []);
  const [initialEntry] = useState(() => {
    if (!hasTabLease) {
      return {
        orphanedSessionIds: [],
        record: {
          id: "learn-blocked",
          status: "provisional" as const,
          title: "学习助手已在另一个标签页中打开",
          createdAt: 0,
          updatedAt: 0,
        },
      };
    }
    const orphanedSessionIds = cleanupProvisionalLearningSessions();
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
      orphanedSessionIds,
      record,
    };
  });
  const [record, setRecord] = useState<LearningSessionRecord>(
    initialEntry.record,
  );
  const [sessions, setSessions] = useState(() => listLearningSessions());
  const [autoCamera, setAutoCamera] = useState<boolean | null>(() => {
    const stored = localStorage.getItem(AUTO_CAMERA_KEY);
    return stored === null ? null : stored === "true";
  });
  const [skillState, setSkillState] = useState<
    "checking" | "ready" | "missing" | "error"
  >("checking");
  const [serverSyncReady, setServerSyncReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const markerSentRef = useRef(false);
  const [wakeSessionId, setWakeSessionId] = useState<string | null>(
    wakeAudio ? record.id : null,
  );

  const refreshLocalSessions = useCallback(() => {
    setSessions(listLearningSessions());
  }, []);

  const handleServerSync = useCallback(
    (discovered: LearningSessionRecord[]) => {
      if (
        !initialEntry.hadResumableSession &&
        record.status === "provisional" &&
        discovered.length > 0
      ) {
        removeLearningSession(record.id);
        const latest = [...discovered].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        )[0];
        const resumed =
          updateLearningSession(latest.id, { status: "active" }) ?? latest;
        markerSentRef.current = false;
        setWakeSessionId(wakeAudio ? resumed.id : null);
        setRecord(resumed);
      }
      refreshLocalSessions();
      setServerSyncReady(true);
    },
    [
      initialEntry.hadResumableSession,
      record.id,
      record.status,
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
    if (!hasTabLease) return;
    let cancelled = false;
    getMyProfileSkills()
      .then((skills) => {
        if (cancelled) return;
        setSkillState(
          skills.some((skill) => skill.name === "learning-coach")
            ? "ready"
            : "missing",
        );
      })
      .catch(() => {
        if (!cancelled) setSkillState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [hasTabLease]);

  useEffect(() => {
    if (!hasTabLease || record.status !== "provisional") return;
    const timer = window.setTimeout(() => {
      removeLearningSession(record.id);
      void deleteSession(record.id).catch(() => undefined);
      navigate("/");
    }, PROVISIONAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [hasTabLease, navigate, record.id, record.status]);

  const buildTurnText = useCallback<NonNullable<VoiceConversationOptions["buildTurnText"]>>(
    ({ currentFramePath }) => {
      if (!markerSentRef.current) {
        markerSentRef.current = true;
        const sessionContext = buildLearningSessionContext({
          sessionId: record.id,
          entry:
            wakeSessionId === record.id ? "wake-word" : "direct",
          provisional: record.status === "provisional",
        });
        return currentFramePath
          ? `${sessionContext}\n${buildLearningTurnContext({
              sessionId: record.id,
              provisional:
                record.status === "provisional" ? true : undefined,
              currentFrame: currentFramePath,
            })}`
          : sessionContext;
      }
      return buildLearningTurnContext({
        sessionId: record.id,
        provisional:
          record.status === "provisional" ? true : undefined,
        currentFrame: currentFramePath,
      });
    },
    [record.id, record.status, wakeSessionId],
  );

  const conversationOptions = useMemo<VoiceConversationOptions>(
    () => ({
      autoStartCamera: autoCamera === true,
      buildTurnText,
      showExistingTurns: true,
    }),
    [autoCamera, buildTurnText],
  );

  const handleTurnsChange = useCallback(
    (turns: VoiceConversationTurn[]) => {
      if (record.status !== "provisional") return;
      const substantive = turns.find((turn) =>
        isSubstantiveLearningText(turn.userText),
      );
      if (!substantive) return;
      const promoted = promoteLearningSession(record.id, substantive.userText);
      if (!promoted) return;
      setRecord(promoted);
      refreshLocalSessions();
      void setSessionTitle(promoted.id, promoted.title).catch(() => {
        // Local title remains usable when an older server cannot persist it.
      });
    },
    [record.id, record.status, refreshLocalSessions],
  );

  const leave = useCallback(() => {
    if (record.status === "provisional") {
      void deleteSession(record.id).catch(() => undefined);
      cleanupProvisionalLearningSessions();
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
    setWakeSessionId(null);
    setRecord(resumed);
    refreshLocalSessions();
    setSidebarOpen(false);
  }, [record.id, record.status, refreshLocalSessions]);

  const newSession = useCallback(() => {
    if (record.status === "provisional") {
      void deleteSession(record.id).catch(() => undefined);
      cleanupProvisionalLearningSessions();
    } else if (record.status === "active") {
      updateLearningSession(record.id, { status: "paused" });
    }
    const next = createProvisionalLearningSession();
    markerSentRef.current = false;
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
      <div className="flex h-screen w-screen items-center justify-center bg-black px-6 text-white">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">学习助手已在另一个标签页中使用</h1>
          <p className="mt-3 text-sm leading-6 text-white/55">
            为避免两个页面同时占用麦克风，请先关闭另一个学习页，再刷新这里。
          </p>
        </div>
      </div>
    );
  }

  if (skillState !== "ready") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black px-6 text-white">
        <div className="w-full max-w-md text-center">
          <BookOpen className="mx-auto mb-5 text-cyan-300" size={36} />
          <h1 className="text-xl font-semibold">
            {skillState === "checking"
              ? "正在检查学习教练…"
              : skillState === "missing"
                ? "需要安装 learning-coach Skill"
                : "暂时无法确认 learning-coach Skill"}
          </h1>
          {skillState !== "checking" && (
            <>
              <p className="mt-3 text-sm leading-6 text-white/55">
                学习页依赖这套教学与记忆规则；安装后请按提示重启 Gateway。
              </p>
              <button
                type="button"
                onClick={() => navigate("/settings?tab=skills")}
                className="mt-6 rounded-full bg-white px-5 py-3 text-sm font-medium text-black"
              >
                打开 Skill 设置
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (autoCamera === null) {
    return <LearningPermissionGate onReady={setAutoCamera} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-black text-white">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭学习会话列表"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-20 bg-black/60 md:hidden"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 shrink-0 flex-col border-r border-white/10 bg-zinc-950 p-4 transition-transform md:static md:w-64 md:translate-x-0 ${
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
                className="p-1 text-white/30 opacity-0 group-hover:opacity-100"
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
                className="mr-2 p-1 text-white/30 opacity-0 group-hover:opacity-100"
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
          className="absolute left-[4.25rem] top-5 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/70 md:hidden"
        >
          <Menu size={20} />
        </button>
        <LearningSessionScope record={record}>
          <OrphanSessionCleanup
            sessionIds={initialEntry.orphanedSessionIds}
          />
          <LearningServerSync onDone={handleServerSync} />
          {serverSyncReady ? (
            <VoiceView
              key={record.id}
              sessionId={record.id}
              initialAudio={
                wakeSessionId === record.id ? wakeAudio : null
              }
              conversationOptions={conversationOptions}
              onTurnsChange={handleTurnsChange}
              onBack={leave}
              onVoiceExit={finishAndLeave}
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
