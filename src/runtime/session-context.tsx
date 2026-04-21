import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  listSessions,
  getMessages,
  getSessionTasks,
  deleteSession as apiDeleteSession,
} from "@/api/sessions";
import type { BackgroundTaskInfo, SessionInfo, MessageInfo } from "@/api/types";
import { nextTopicForCommand } from "@/lib/slash-commands";
import * as MessageStore from "@/store/message-store";

const SESSION_TITLE_STORAGE_KEY = "octos_session_titles";
const SESSION_STATS_STORAGE_KEY = "octos_session_stats";
const SESSION_TOPIC_STORAGE_KEY = "octos_session_topics";
const SESSION_SYNC_STORAGE_KEY = "octos_sessions_sync";

function isTaskActive(task: BackgroundTaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

/** Extract a short title from message content, handling JSON content parts. */
function extractTitle(content: string): string {
  let text = content;
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const textPart = parsed.find(
        (p: { type?: string; text?: string }) => p.type === "text" && p.text,
      );
      if (textPart) text = textPart.text;
    }
  } catch {
    // plain text
  }
  return text.slice(0, 50).trim() || "";
}

/** Session with a display title derived from the first user message. */
export interface SessionWithTitle extends SessionInfo {
  title?: string;
  /** True if this session was created locally and not yet in the API. */
  _local?: boolean;
}

export interface SessionRunStats {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
}

export interface SessionSendRequest {
  sessionId: string;
  text: string;
  requestText: string;
  media: string[];
  audioUploadMode?: "recording" | "upload";
}

export interface SessionBeforeSendResult extends Partial<SessionSendRequest> {
  handled?: boolean;
}

export type QueueMode = "followup" | "collect" | "steer" | "interrupt" | "speculative" | null;
export type AdaptiveMode = "off" | "hedge" | "lane" | null;

/** Shared hook that listens for crew:mode_update events and returns reactive mode state. */
export function useModeState() {
  const [queueMode, setQueueMode] = useState<QueueMode>(null);
  const [adaptiveMode, setAdaptiveMode] = useState<AdaptiveMode>(null);

  useEffect(() => {
    function onMode(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.queueMode !== undefined) setQueueMode(detail.queueMode);
      if (detail.adaptiveMode !== undefined) setAdaptiveMode(detail.adaptiveMode);
    }
    window.addEventListener("crew:mode_update", onMode);
    return () => window.removeEventListener("crew:mode_update", onMode);
  }, []);

  return { queueMode, adaptiveMode };
}

interface SessionContextValue {
  sessions: SessionWithTitle[];
  currentSessionId: string;
  historyTopic?: string;
  currentSessionTitle: string;
  currentSessionStats: SessionRunStats | null;
  initialMessages: MessageInfo[];
  /** True if the current session has background work pending on the server. */
  activeTaskOnServer: boolean;
  /** Current queue mode as reported by backend /queue response. */
  queueMode: QueueMode;
  /** Current adaptive routing mode as reported by backend /adaptive response. */
  adaptiveMode: AdaptiveMode;
  setServerTaskActive: (sessionId: string, active: boolean) => void;
  renameSession: (sessionId: string, title: string) => void;
  updateSessionStats: (sessionId: string, stats: Partial<SessionRunStats>) => void;
  switchSession: (id: string) => void;
  goBack: () => Promise<boolean>;
  createSession: (title?: string) => string;
  removeSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  /** Mark the current session as active (has sent at least one message). */
  markSessionActive: (firstMessage?: string) => void;
  /** Optional per-surface hook that can initialize or rewrite a send before it hits the SSE bridge. */
  beforeSend?: (
    request: SessionSendRequest,
  ) => Promise<SessionBeforeSendResult | void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

function generateSessionId(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadStoredTitles(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SESSION_TITLE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistStoredTitles(titles: Record<string, string>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_TITLE_STORAGE_KEY, JSON.stringify(titles));
}

function loadStoredStats(): Record<string, SessionRunStats> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SESSION_STATS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistStoredStats(stats: Record<string, SessionRunStats>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_STATS_STORAGE_KEY, JSON.stringify(stats));
}

function loadStoredTopics(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SESSION_TOPIC_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistStoredTopics(topics: Record<string, string>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_TOPIC_STORAGE_KEY, JSON.stringify(topics));
}

function mergeNullableCost(
  nextCost: number | null | undefined,
  currentCost: number | null,
): number | null {
  return nextCost === undefined ? currentCost : nextCost;
}

function setSessionActiveFlag(
  current: Record<string, boolean>,
  sessionId: string,
  active: boolean,
): Record<string, boolean> {
  if (current[sessionId] === active) return current;
  const next = { ...current };
  if (active) {
    next[sessionId] = true;
  } else {
    delete next[sessionId];
  }
  return next;
}

/** Extract a sortable timestamp from a session ID.
 *  Handles both formats:
 *    web-{timestamp}-{random}  → timestamp directly (milliseconds)
 *    web-{uuid-v7}             → extract ms from UUID v7 first 48 bits
 */
function sessionTimestamp(s: SessionInfo): number {
  const id = s.id.replace("web-", "");
  // UUID v7: 019d044f-aa95-7d92-...  (first 12 hex chars = 48-bit timestamp)
  if (id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)) {
    const hex = id.replace(/-/g, "").slice(0, 12);
    return parseInt(hex, 16);
  }
  // Timestamp: 1773856707984-nt380h
  const ts = parseInt(id.split("-")[0], 10);
  if (!isNaN(ts) && ts > 1700000000000) return ts;
  // Fallback: use created_at if available, or 0
  return 0;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionWithTitle[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState(() => {
    // Restore last session on refresh, or generate a new one
    const saved = localStorage.getItem("octos_current_session");
    return saved || generateSessionId();
  });
  const [activeHistoryTopic, setActiveHistoryTopic] = useState<string | undefined>(() => {
    const saved = localStorage.getItem("octos_current_session");
    const topics = loadStoredTopics();
    return saved ? topics[saved] : undefined;
  });
  const [initialMessages, setInitialMessages] = useState<MessageInfo[]>([]);
  const [serverTaskActiveBySession, setServerTaskActiveBySession] = useState<
    Record<string, boolean>
  >({});
  const { queueMode, adaptiveMode } = useModeState();
  const previousSessionIdRef = useRef<string | null>(null);
  const titleCache = useRef<Record<string, string>>(loadStoredTitles());
  const statsCache = useRef<Record<string, SessionRunStats>>(loadStoredStats());
  const [currentSessionStatsState, setCurrentSessionStatsState] =
    useState<SessionRunStats | null>(() => statsCache.current[currentSessionId] ?? null);
  const [sessionTopics, setSessionTopics] = useState<Record<string, string>>(() =>
    loadStoredTopics(),
  );

  useEffect(() => {
    setCurrentSessionStatsState(statsCache.current[currentSessionId] ?? null);
  }, [currentSessionId]);

  const storeSessionStats = useCallback(
    (sessionId: string, stats: SessionRunStats) => {
      statsCache.current[sessionId] = stats;
      persistStoredStats(statsCache.current);
      if (sessionId === currentSessionId) {
        setCurrentSessionStatsState(stats);
      }
    },
    [currentSessionId],
  );

  // Persist current session ID for refresh recovery
  useEffect(() => {
    localStorage.setItem("octos_current_session", currentSessionId);
  }, [currentSessionId]);

  // Load history for restored session on mount
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const saved = localStorage.getItem("octos_current_session");
    if (saved && saved.startsWith("web-")) {
      const restoredTopic = sessionTopics[saved];
      getMessages(saved, 500, 0, undefined, restoredTopic).then((msgs) => {
        if (msgs.length > 0) {
          setInitialMessages(msgs);
          MessageStore.replaceHistory(saved, msgs, restoredTopic);
        }
      }).catch(() => {});
      getSessionTasks(saved, restoredTopic)
        .then((tasks) => {
          setServerTaskActiveBySession((prev) =>
            setSessionActiveFlag(prev, saved, tasks.some(isTaskActive)),
          );
        })
        .catch(() => {});
      setActiveHistoryTopic(restoredTopic);
    }
  }, [sessionTopics]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      const webSessions = list
        .filter((s) => s.id.startsWith("web-") && (s.message_count ?? 0) > 0)
        .sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a))
        .slice(0, 20);

      // Fetch titles for sessions we haven't seen
      const needTitle = webSessions.filter((s) => !titleCache.current[s.id]);
      await Promise.all(
        needTitle.slice(0, 10).map(async (s) => {
          try {
            const msgs = await getMessages(s.id, 10);
            const firstUser = msgs.find((m) => m.role === "user" && m.content?.trim());
            if (firstUser) {
              titleCache.current[s.id] = extractTitle(firstUser.content);
              persistStoredTitles(titleCache.current);
            }
          } catch {
            // ignore
          }
        }),
      );

      setSessions((prev) => {
        const fromApi = webSessions.map((s) => ({
          ...s,
          title: titleCache.current[s.id],
        }));
        // Preserve any locally-tracked sessions that aren't in the API yet
        const apiIds = new Set(fromApi.map((s) => s.id));
        const localOnly = prev.filter(
          (s) => s._local && !apiIds.has(s.id),
        );
        return [...localOnly, ...fromApi];
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshSessions();
      }
    };
    const refreshOnFocus = () => {
      void refreshSessions();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SESSION_SYNC_STORAGE_KEY) {
        void refreshSessions();
      }
    };

    const interval = window.setInterval(refreshIfVisible, 15_000);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, [refreshSessions]);

  useEffect(() => {
    function handleCost(e: Event) {
      const detail = (e as CustomEvent).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      const current = statsCache.current[sessionId] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
      };
      storeSessionStats(sessionId, {
        ...current,
        inputTokens: detail.input_tokens ?? current.inputTokens,
        outputTokens: detail.output_tokens ?? current.outputTokens,
        cost: mergeNullableCost(detail.session_cost, current.cost),
      });
    }

    function handleMeta(e: Event) {
      const detail = (e as CustomEvent).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      const current = statsCache.current[sessionId] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
      };
      storeSessionStats(sessionId, {
        ...current,
        model: detail.model || current.model,
        inputTokens: detail.tokens_in ?? current.inputTokens,
        outputTokens: detail.tokens_out ?? current.outputTokens,
        cost: mergeNullableCost(detail.session_cost, current.cost),
      });
    }

    window.addEventListener("crew:cost", handleCost);
    window.addEventListener("crew:message_meta", handleMeta);
    return () => {
      window.removeEventListener("crew:cost", handleCost);
      window.removeEventListener("crew:message_meta", handleMeta);
    };
  }, [storeSessionStats]);

  const switchRequestRef = useRef(0);
  const setServerTaskActive = useCallback(
    (sessionId: string, active: boolean) => {
      setServerTaskActiveBySession((prev) =>
        setSessionActiveFlag(prev, sessionId, active),
      );
    },
    [],
  );

  const renameSession = useCallback((sessionId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    titleCache.current[sessionId] = trimmed;
    persistStoredTitles(titleCache.current);
    setSessions((prev) => {
      const existing = prev.find((s) => s.id === sessionId);
      if (existing) {
        return prev.map((s) => (s.id === sessionId ? { ...s, title: trimmed } : s));
      }
      return [{ id: sessionId, message_count: 0, title: trimmed, _local: true }, ...prev];
    });
  }, []);

  const updateSessionStats = useCallback(
    (sessionId: string, stats: Partial<SessionRunStats>) => {
      const current = statsCache.current[sessionId] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
      };
      storeSessionStats(sessionId, {
        ...current,
        ...stats,
      });
    },
    [storeSessionStats],
  );

  const switchSession = useCallback(async (id: string) => {
    if (id !== currentSessionId) {
      previousSessionIdRef.current = currentSessionId;
    }
    // Guard against race: only the latest switch request wins
    const requestId = ++switchRequestRef.current;
    const topic = sessionTopics[id];
    try {
      const [messages, tasks] = await Promise.all([
        getMessages(id, 500, 0, undefined, topic),
        getSessionTasks(id, topic).catch(() => [] as BackgroundTaskInfo[]),
      ]);
      if (switchRequestRef.current !== requestId) return; // stale
      MessageStore.replaceHistory(id, messages, topic);
      setInitialMessages(messages);
      setServerTaskActive(id, tasks.some(isTaskActive));
      setActiveHistoryTopic(topic);
    } catch {
      if (switchRequestRef.current !== requestId) return;
      setInitialMessages([]);
      setServerTaskActive(id, false);
      setActiveHistoryTopic(topic);
    }
    setCurrentSessionId(id);
  }, [currentSessionId, sessionTopics, setServerTaskActive]);

  const createSession = useCallback((title?: string) => {
    const nextId = generateSessionId();
    previousSessionIdRef.current = currentSessionId;
    const trimmedTitle = title?.trim();
    if (trimmedTitle) {
      titleCache.current[nextId] = trimmedTitle;
      persistStoredTitles(titleCache.current);
      setSessions((prev) => [
        { id: nextId, message_count: 0, title: trimmedTitle, _local: true },
        ...prev,
      ]);
    }
    setInitialMessages([]);
    setActiveHistoryTopic(undefined);
    setCurrentSessionId(nextId);
    return nextId;
  }, [currentSessionId]);

  const goBack = useCallback(async () => {
    const previous = previousSessionIdRef.current;
    if (!previous || previous === currentSessionId) return false;
    await switchSession(previous);
    return true;
  }, [currentSessionId, switchSession]);

  const markSessionActive = useCallback(
    (firstMessage?: string) => {
      const existingTitle = titleCache.current[currentSessionId];
      const title =
        !existingTitle && firstMessage ? extractTitle(firstMessage) : existingTitle;
      const nextTopic = firstMessage ? nextTopicForCommand(firstMessage) : undefined;
      if (nextTopic !== undefined) {
        const normalizedNext = nextTopic?.trim() || undefined;
        setActiveHistoryTopic(normalizedNext);
        setSessionTopics((prev) => {
          const current = prev[currentSessionId];
          const normalizedStored = normalizedNext || "";
          if (!normalizedStored && !current) return prev;
          if (normalizedStored && current === normalizedStored) return prev;
          const next = { ...prev };
          if (normalizedStored) {
            next[currentSessionId] = normalizedStored;
          } else {
            delete next[currentSessionId];
          }
          persistStoredTopics(next);
          return next;
        });
      }
      if (title && !existingTitle) {
        titleCache.current[currentSessionId] = title;
        persistStoredTitles(titleCache.current);
      }
      setSessions((prev) => {
        const existing = prev.find((s) => s.id === currentSessionId);
        if (existing) {
          // Update title if it was missing
          if (!existing.title && title) {
            return prev.map((s) =>
              s.id === currentSessionId ? { ...s, title } : s,
            );
          }
          return prev;
        }
        return [
          { id: currentSessionId, message_count: 1, title, _local: true },
          ...prev,
        ];
      });
    },
    [currentSessionId],
  );

  const removeSession = useCallback(async (id: string) => {
    try {
      await apiDeleteSession(id);
      if (titleCache.current[id]) {
        delete titleCache.current[id];
        persistStoredTitles(titleCache.current);
      }
      if (statsCache.current[id]) {
        delete statsCache.current[id];
        persistStoredStats(statsCache.current);
      }
      setSessionTopics((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        persistStoredTopics(next);
        return next;
      });
      setServerTaskActive(id, false);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === currentSessionId) {
        setInitialMessages([]);
        setActiveHistoryTopic(undefined);
        setCurrentSessionId(generateSessionId());
      }
      localStorage.setItem(SESSION_SYNC_STORAGE_KEY, String(Date.now()));
      await refreshSessions();
    } catch {
      // ignore
    }
  }, [currentSessionId, refreshSessions, setServerTaskActive]);

  const currentSessionTitle =
    sessions.find((s) => s.id === currentSessionId)?.title ||
    titleCache.current[currentSessionId] ||
    formatSessionName(currentSessionId);
  const currentSessionStats = currentSessionStatsState;
  const activeTaskOnServer = serverTaskActiveBySession[currentSessionId] ?? false;

  return (
    <SessionContext.Provider
      value={{
        sessions,
        currentSessionId,
        historyTopic: activeHistoryTopic,
        currentSessionTitle,
        currentSessionStats,
        initialMessages,
        activeTaskOnServer,
        queueMode,
        adaptiveMode,
        setServerTaskActive,
        renameSession,
        updateSessionStats,
        switchSession,
        goBack,
        createSession,
        removeSession,
        refreshSessions,
        markSessionActive,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

function formatSessionName(id: string): string {
  if (id.startsWith("web-")) {
    const parts = id.split("-");
    if (parts.length >= 2) {
      const ts = parseInt(parts[1], 10);
      if (!isNaN(ts)) {
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }
    }
  }
  return id;
}
