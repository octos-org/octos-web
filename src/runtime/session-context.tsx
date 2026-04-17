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

const SESSION_TITLE_STORAGE_KEY = "octos_session_titles";
const SESSION_STATS_STORAGE_KEY = "octos_session_stats";
const SESSION_TOPIC_STORAGE_KEY = "octos_session_topics";

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
  setHistoryTopic: (topic?: string) => void;
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
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const topics: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== "string" || typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      topics[key] = trimmed;
    }
    return topics;
  } catch {
    return {};
  }
}

function persistStoredTopics(topics: Record<string, string>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_TOPIC_STORAGE_KEY, JSON.stringify(topics));
}

function splitSessionAddress(id: string): { sessionId: string; topic?: string } {
  const separator = id.indexOf("#");
  if (separator === -1) return { sessionId: id };
  const sessionId = id.slice(0, separator);
  const topic = id.slice(separator + 1).trim();
  return {
    sessionId,
    topic: topic || undefined,
  };
}

function sessionAddress(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
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
    const saved = localStorage.getItem("octos_current_session");
    if (!saved) return generateSessionId();
    return splitSessionAddress(saved).sessionId || generateSessionId();
  });
  const [historyTopic, setHistoryTopicState] = useState<string | undefined>(() => {
    const saved = localStorage.getItem("octos_current_session");
    if (saved) {
      const parsed = splitSessionAddress(saved);
      if (parsed.topic) return parsed.topic;
      const storedTopics = loadStoredTopics();
      const remembered = storedTopics[parsed.sessionId];
      if (remembered?.trim()) return remembered.trim();
    }
    return undefined;
  });
  const [initialMessages, setInitialMessages] = useState<MessageInfo[]>([]);
  const [activeTaskOnServer, setActiveTaskOnServer] = useState(false);
  const { queueMode, adaptiveMode } = useModeState();
  const previousSessionIdRef = useRef<string | null>(null);
  const titleCache = useRef<Record<string, string>>(loadStoredTitles());
  const statsCache = useRef<Record<string, SessionRunStats>>(loadStoredStats());
  const topicCache = useRef<Record<string, string>>(loadStoredTopics());

  // Persist current session ID/topic for refresh recovery.
  useEffect(() => {
    const trimmedTopic = historyTopic?.trim();
    if (trimmedTopic) {
      topicCache.current[currentSessionId] = trimmedTopic;
    } else {
      delete topicCache.current[currentSessionId];
    }
    persistStoredTopics(topicCache.current);
    localStorage.setItem(
      "octos_current_session",
      sessionAddress(currentSessionId, trimmedTopic),
    );
  }, [currentSessionId, historyTopic]);

  // Load history for restored session on mount
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const saved = localStorage.getItem("octos_current_session");
    if (saved && saved.startsWith("web-")) {
      const parsed = splitSessionAddress(saved);
      const restoredTopic = parsed.topic || topicCache.current[parsed.sessionId];
      getMessages(parsed.sessionId, 500, 0, undefined, restoredTopic).then((msgs) => {
        if (msgs.length > 0) setInitialMessages(msgs);
      }).catch(() => {});
      getSessionTasks(parsed.sessionId, restoredTopic)
        .then((tasks) => {
          setActiveTaskOnServer(tasks.some(isTaskActive));
        })
        .catch(() => {});
    }
  }, []);

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
            const parsed = splitSessionAddress(s.id);
            const msgs = await getMessages(
              parsed.sessionId,
              10,
              0,
              undefined,
              parsed.topic,
            );
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
    function handleCost(e: Event) {
      const detail = (e as CustomEvent).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      const current = statsCache.current[sessionId] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
      };
      statsCache.current[sessionId] = {
        ...current,
        inputTokens: detail.input_tokens ?? current.inputTokens,
        outputTokens: detail.output_tokens ?? current.outputTokens,
        cost: detail.session_cost ?? current.cost,
      };
      persistStoredStats(statsCache.current);
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
      statsCache.current[sessionId] = {
        ...current,
        model: detail.model || current.model,
        inputTokens: detail.tokens_in ?? current.inputTokens,
        outputTokens: detail.tokens_out ?? current.outputTokens,
      };
      persistStoredStats(statsCache.current);
    }

    window.addEventListener("crew:cost", handleCost);
    window.addEventListener("crew:message_meta", handleMeta);
    return () => {
      window.removeEventListener("crew:cost", handleCost);
      window.removeEventListener("crew:message_meta", handleMeta);
    };
  }, []);

  const switchRequestRef = useRef(0);
  const setHistoryTopic = useCallback((topic?: string) => {
    const trimmed = topic?.trim();
    setHistoryTopicState(trimmed || undefined);
  }, []);
  const setServerTaskActive = useCallback(
    (sessionId: string, active: boolean) => {
      setActiveTaskOnServer((prev) => {
        if (sessionId !== currentSessionId) return prev;
        return active;
      });
    },
    [currentSessionId],
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
      statsCache.current[sessionId] = {
        ...current,
        ...stats,
      };
      persistStoredStats(statsCache.current);
    },
    [],
  );

  const switchSession = useCallback(async (id: string) => {
    const parsed = splitSessionAddress(id);
    const nextTopic = parsed.topic ?? topicCache.current[parsed.sessionId];

    if (parsed.sessionId !== currentSessionId || nextTopic !== historyTopic) {
      previousSessionIdRef.current = sessionAddress(currentSessionId, historyTopic);
    }
    // Guard against race: only the latest switch request wins
    const requestId = ++switchRequestRef.current;
    try {
      const [messages, tasks] = await Promise.all([
        getMessages(parsed.sessionId, 500, 0, undefined, nextTopic),
        getSessionTasks(parsed.sessionId, nextTopic).catch(() => [] as BackgroundTaskInfo[]),
      ]);
      if (switchRequestRef.current !== requestId) return; // stale
      setInitialMessages(messages);
      setActiveTaskOnServer(tasks.some(isTaskActive));
    } catch {
      if (switchRequestRef.current !== requestId) return;
      setInitialMessages([]);
      setActiveTaskOnServer(false);
    }
    setCurrentSessionId(parsed.sessionId);
    setHistoryTopicState(nextTopic?.trim() || undefined);
  }, [currentSessionId, historyTopic]);

  const createSession = useCallback((title?: string) => {
    const nextId = generateSessionId();
    previousSessionIdRef.current = sessionAddress(currentSessionId, historyTopic);
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
    setHistoryTopicState(undefined);
    setCurrentSessionId(nextId);
    return nextId;
  }, [currentSessionId, historyTopic]);

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
      const parsed = splitSessionAddress(id);
      await apiDeleteSession(parsed.sessionId);
      if (titleCache.current[id]) {
        delete titleCache.current[id];
        persistStoredTitles(titleCache.current);
      }
      if (titleCache.current[parsed.sessionId]) {
        delete titleCache.current[parsed.sessionId];
        persistStoredTitles(titleCache.current);
      }
      if (statsCache.current[parsed.sessionId]) {
        delete statsCache.current[parsed.sessionId];
        persistStoredStats(statsCache.current);
      }
      delete topicCache.current[parsed.sessionId];
      persistStoredTopics(topicCache.current);
      setSessions((prev) =>
        prev.filter(
          (s) => s.id !== id && s.id !== parsed.sessionId && !s.id.startsWith(`${parsed.sessionId}#`),
        ),
      );
      if (parsed.sessionId === currentSessionId) {
        setInitialMessages([]);
        setHistoryTopicState(undefined);
        setCurrentSessionId(generateSessionId());
      }
    } catch {
      // ignore
    }
  }, [currentSessionId]);

  const currentSessionLookupKey = sessionAddress(currentSessionId, historyTopic);
  const currentSessionTitle =
    sessions.find((s) => s.id === currentSessionLookupKey)?.title ||
    titleCache.current[currentSessionLookupKey] ||
    sessions.find((s) => s.id === currentSessionId)?.title ||
    titleCache.current[currentSessionId] ||
    formatSessionName(currentSessionId);
  const currentSessionStats = statsCache.current[currentSessionId] ?? null;

  return (
    <SessionContext.Provider
      value={{
        sessions,
        currentSessionId,
        historyTopic,
        setHistoryTopic,
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
