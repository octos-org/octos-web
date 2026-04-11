import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { listSessions, getMessages, getSessionStatus, deleteSession as apiDeleteSession } from "@/api/sessions";
import type { SessionInfo, MessageInfo } from "@/api/types";

const SESSION_TITLE_STORAGE_KEY = "octos_session_titles";
const SESSION_STATS_STORAGE_KEY = "octos_session_stats";

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

interface SessionContextValue {
  sessions: SessionWithTitle[];
  currentSessionId: string;
  currentSessionTitle: string;
  currentSessionStats: SessionRunStats | null;
  initialMessages: MessageInfo[];
  /** True if the current session has background work pending on the server. */
  activeTaskOnServer: boolean;
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
  const [initialMessages, setInitialMessages] = useState<MessageInfo[]>([]);
  const [activeTaskOnServer, setActiveTaskOnServer] = useState(false);
  const previousSessionIdRef = useRef<string | null>(null);
  const titleCache = useRef<Record<string, string>>(loadStoredTitles());
  const statsCache = useRef<Record<string, SessionRunStats>>(loadStoredStats());

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
      getMessages(saved).then((msgs) => {
        if (msgs.length > 0) setInitialMessages(msgs);
      }).catch(() => {});
      getSessionStatus(saved).then((status) => {
        setActiveTaskOnServer(
          Boolean(status.has_bg_tasks || status.has_deferred_files),
        );
      }).catch(() => {});
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
    if (id !== currentSessionId) {
      previousSessionIdRef.current = currentSessionId;
    }
    // Guard against race: only the latest switch request wins
    const requestId = ++switchRequestRef.current;
    try {
      const [messages, status] = await Promise.all([
        getMessages(id),
        getSessionStatus(id).catch(() => ({
          active: false,
          has_deferred_files: false,
          has_bg_tasks: false,
        })),
      ]);
      if (switchRequestRef.current !== requestId) return; // stale
      setInitialMessages(messages);
      setActiveTaskOnServer(
        Boolean(status.has_bg_tasks || status.has_deferred_files),
      );
    } catch {
      if (switchRequestRef.current !== requestId) return;
      setInitialMessages([]);
      setActiveTaskOnServer(false);
    }
    setCurrentSessionId(id);
  }, []);

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
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === currentSessionId) {
        setInitialMessages([]);
        setCurrentSessionId(generateSessionId());
      }
    } catch {
      // ignore
    }
  }, [currentSessionId]);

  const currentSessionTitle =
    sessions.find((s) => s.id === currentSessionId)?.title ||
    titleCache.current[currentSessionId] ||
    formatSessionName(currentSessionId);
  const currentSessionStats = statsCache.current[currentSessionId] ?? null;

  return (
    <SessionContext.Provider
      value={{
        sessions,
        currentSessionId,
        currentSessionTitle,
        currentSessionStats,
        initialMessages,
        activeTaskOnServer,
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
