import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { listSessions, getMessages, deleteSession as apiDeleteSession } from "@/api/sessions";
import type { SessionInfo, MessageInfo } from "@/api/types";

interface SessionContextValue {
  sessions: SessionInfo[];
  currentSessionId: string;
  initialMessages: MessageInfo[];
  switchSession: (id: string) => void;
  createSession: () => void;
  removeSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
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
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState(generateSessionId);
  const [initialMessages, setInitialMessages] = useState<MessageInfo[]>([]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      const webSessions = list
        .filter((s) => s.id.startsWith("web-") && (s.message_count ?? 0) > 0)
        .sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a))
        .slice(0, 20);
      setSessions(webSessions);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const switchSession = useCallback(async (id: string) => {
    // Load history for existing sessions
    try {
      const messages = await getMessages(id);
      setInitialMessages(messages);
    } catch {
      setInitialMessages([]);
    }
    setCurrentSessionId(id);
  }, []);

  const createSession = useCallback(() => {
    setInitialMessages([]);
    setCurrentSessionId(generateSessionId());
  }, []);

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
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
