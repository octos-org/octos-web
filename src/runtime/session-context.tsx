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

interface SessionContextValue {
  sessions: SessionWithTitle[];
  currentSessionId: string;
  initialMessages: MessageInfo[];
  /** True if the current session has a task running on the server. */
  activeTaskOnServer: boolean;
  switchSession: (id: string) => void;
  createSession: () => void;
  removeSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  /** Mark the current session as active (has sent at least one message). */
  markSessionActive: (firstMessage?: string) => void;
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
  const titleCache = useRef<Record<string, string>>({});

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
        setActiveTaskOnServer(status.active);
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

  const switchRequestRef = useRef(0);
  const switchSession = useCallback(async (id: string) => {
    // Guard against race: only the latest switch request wins
    const requestId = ++switchRequestRef.current;
    try {
      const [messages, status] = await Promise.all([
        getMessages(id),
        getSessionStatus(id).catch(() => ({ active: false, has_deferred_files: false })),
      ]);
      if (switchRequestRef.current !== requestId) return; // stale
      setInitialMessages(messages);
      setActiveTaskOnServer(status.active);
    } catch {
      if (switchRequestRef.current !== requestId) return;
      setInitialMessages([]);
      setActiveTaskOnServer(false);
    }
    setCurrentSessionId(id);
  }, []);

  const createSession = useCallback(() => {
    setInitialMessages([]);
    setCurrentSessionId(generateSessionId());
  }, []);

  const markSessionActive = useCallback(
    (firstMessage?: string) => {
      const title = firstMessage ? extractTitle(firstMessage) : undefined;
      if (title) titleCache.current[currentSessionId] = title;
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
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === currentSessionId) {
        setInitialMessages([]);
        setCurrentSessionId(generateSessionId());
      }
    } catch {
      // ignore
    }
  }, [currentSessionId]);

  return (
    <SessionContext.Provider
      value={{
        sessions,
        currentSessionId,
        initialMessages,
        activeTaskOnServer,
        switchSession,
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
