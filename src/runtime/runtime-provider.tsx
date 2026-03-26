import { type ReactNode, useCallback, useMemo } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from "@assistant-ui/react";
import { createOctosAdapter } from "./octos-adapter";
import { SessionProvider, useSession } from "./session-context";
import type { MessageInfo } from "@/api/types";

/** Shared ref for pending media paths — set by Composer, consumed by adapter. */
export const pendingMediaRef: { current: string[] } = { current: [] };

function convertToInitialMessages(
  messages: MessageInfo[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}

function RuntimeInner({
  children,
  sessionId,
  historyMessages,
}: {
  children: ReactNode;
  sessionId: string;
  historyMessages: MessageInfo[];
}) {
  const { refreshSessions } = useSession();

  const getSessionId = useCallback(() => sessionId, [sessionId]);

  const adapter = useMemo(() => {
    const getPendingMedia = () => {
      const media = [...pendingMediaRef.current];
      pendingMediaRef.current = [];
      return media;
    };
    return createOctosAdapter(getSessionId, refreshSessions, getPendingMedia);
  }, [getSessionId, refreshSessions]);

  const initialMessages = useMemo(
    () => convertToInitialMessages(historyMessages),
    [historyMessages],
  );

  const runtime = useLocalRuntime(adapter, {
    initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

function RuntimeWithSession({ children }: { children: ReactNode }) {
  const { currentSessionId, initialMessages } = useSession();

  // key={currentSessionId} forces a full remount when switching sessions,
  // which resets the thread messages and creates a fresh runtime.
  return (
    <RuntimeInner
      key={currentSessionId}
      sessionId={currentSessionId}
      historyMessages={initialMessages}
    >
      {children}
    </RuntimeInner>
  );
}

export function OctosRuntimeProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <RuntimeWithSession>{children}</RuntimeWithSession>
    </SessionProvider>
  );
}
