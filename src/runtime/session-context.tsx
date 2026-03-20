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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState(() => {
    const id = generateSessionId();
    console.log("[session] initial sessionId:", id);
    return id;
  });
  const [initialMessages, setInitialMessages] = useState<MessageInfo[]>([]);

  const refreshSessions = useCallback(async () => {
    console.log("[session] refreshSessions called");
    try {
      const list = await listSessions();
      // Only show web client sessions with messages, most recent first, limit 20
      const webSessions = list
        .filter((s) => s.id.startsWith("web-") && (s.message_count ?? 0) > 0)
        .slice(-20); // API returns oldest first, take last 20 = most recent
      console.log("[session] refreshSessions got", list.length, "total,", webSessions.length, "shown");
      setSessions(webSessions.reverse()); // newest first in sidebar
    } catch (e) {
      console.warn("[session] refreshSessions failed:", e);
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
