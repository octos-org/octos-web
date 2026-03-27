import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from "@assistant-ui/react";
import { createOctosAdapter } from "./octos-adapter";
import { SessionProvider, useSession } from "./session-context";
import * as StreamManager from "./stream-manager";
import type { MessageInfo } from "@/api/types";

/** Shared ref for pending media paths — set by Composer, consumed by adapter. */
export const pendingMediaRef: { current: string[] } = { current: [] };

function convertToInitialMessages(
  messages: MessageInfo[],
): Array<{ role: "user" | "assistant"; content: string }> {
  // Merge consecutive assistant + tool messages into single assistant messages.
  const result: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "user") {
      result.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.content.trim()) {
        result.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      if (result.length > 0 && result[result.length - 1].role === "assistant") {
        if (m.content.length > 100) {
          result[result.length - 1].content += "\n\n" + m.content;
        }
      } else if (m.content.length > 100) {
        result.push({ role: "assistant", content: m.content });
      }
    }
  }
  return result;
}

/** Max sessions kept mounted simultaneously. */
const MAX_CACHED = 5;

/** A single session runtime — stays mounted when switching away. */
function SessionRuntime({
  sessionId,
  historyMessages,
  active,
  children,
}: {
  sessionId: string;
  historyMessages: MessageInfo[];
  active: boolean;
  children: ReactNode;
}) {
  const { refreshSessions, markSessionActive } = useSession();

  const getSessionId = useCallback(() => sessionId, [sessionId]);

  const adapter = useMemo(() => {
    const getPendingMedia = () => {
      const media = [...pendingMediaRef.current];
      pendingMediaRef.current = [];
      return media;
    };
    return createOctosAdapter(getSessionId, refreshSessions, getPendingMedia, markSessionActive);
  }, [getSessionId, refreshSessions, markSessionActive]);

  const initialMessages = useMemo(
    () => convertToInitialMessages(historyMessages),
    [historyMessages],
  );

  const runtime = useLocalRuntime(adapter, {
    initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
  });

  return (
    <div
      style={{ display: active ? "contents" : "none" }}
      data-session-id={sessionId}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        {children}
      </AssistantRuntimeProvider>
    </div>
  );
}

function RuntimeWithSession({ children }: { children: ReactNode }) {
  const { currentSessionId, initialMessages } = useSession();
  const mountedRef = useRef(new Map<string, { historyMessages: MessageInfo[] }>());

  // Track mounted sessions
  useEffect(() => {
    if (!mountedRef.current.has(currentSessionId)) {
      mountedRef.current.set(currentSessionId, { historyMessages: initialMessages });

      // Evict old sessions if over limit — never evict sessions with active streams
      if (mountedRef.current.size > MAX_CACHED) {
        for (const [id] of mountedRef.current) {
          if (id !== currentSessionId && !StreamManager.isActive(id)) {
            mountedRef.current.delete(id);
            break;
          }
        }
      }
    }
  }, [currentSessionId, initialMessages]);

  // Build the list of all mounted sessions
  const sessions = Array.from(mountedRef.current.entries()).map(([id, data]) => ({
    sessionId: id,
    historyMessages: data.historyMessages,
    active: id === currentSessionId,
  }));

  // Ensure current session is always in the list
  if (!sessions.some((s) => s.sessionId === currentSessionId)) {
    sessions.push({
      sessionId: currentSessionId,
      historyMessages: initialMessages,
      active: true,
    });
  }

  return (
    <>
      {sessions.map((s) => (
        <SessionRuntime
          key={s.sessionId}
          sessionId={s.sessionId}
          historyMessages={s.historyMessages}
          active={s.active}
        >
          {children}
        </SessionRuntime>
      ))}
    </>
  );
}

export function OctosRuntimeProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <RuntimeWithSession>{children}</RuntimeWithSession>
    </SessionProvider>
  );
}
