import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { listSessions, getMessages, deleteSession as apiDeleteSession } from "@/api/sessions";
import type { SessionInfo, MessageInfo } from "@/api/types";

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
  switchSession: (id: string) => void;
  createSession: () => void;
  removeSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  /** Mark the current session as active (has sent at least one message). */
  markSessionActive: (firstMessage?: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

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
  const [currentSessionId, setCurrentSessionId] = useState(generateSessionId);
  const [initialMessages, setInitialMessages] = useState<MessageInfo[]>([]);
  const titleCache = useRef<Record<string, string>>({});

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
            const msgs = await getMessages(s.id, 3);
            const firstUser = msgs.find((m) => m.role === "user");
            if (firstUser) {
              titleCache.current[s.id] = firstUser.content.slice(0, 50).trim();
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
      const messages = await getMessages(id);
      if (switchRequestRef.current !== requestId) return; // stale
      setInitialMessages(messages);
    } catch {
      if (switchRequestRef.current !== requestId) return;
      setInitialMessages([]);
    }
    setCurrentSessionId(id);
  }, []);

  const createSession = useCallback(() => {
    setInitialMessages([]);
    setCurrentSessionId(generateSessionId());
  }, []);

  const markSessionActive = useCallback(
    (firstMessage?: string) => {
      setSessions((prev) => {
        if (prev.some((s) => s.id === currentSessionId)) return prev;
        const title = firstMessage?.slice(0, 50).trim();
        if (title) titleCache.current[currentSessionId] = title;
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
