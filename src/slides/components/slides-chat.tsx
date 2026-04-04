import { useMemo, useEffect } from "react";
import { ChatThread } from "@/components/chat-thread";
import { SessionContext } from "@/runtime/session-context";
import * as MessageStore from "@/store/message-store";

interface Props {
  sessionId: string;
  projectTitle?: string;
}

export function SlidesChat({ sessionId, projectTitle }: Props) {
  // Load history for this session
  useEffect(() => {
    MessageStore.loadHistory(sessionId);
  }, [sessionId]);

  const sessionValue = useMemo(
    () => ({
      sessions: [],
      currentSessionId: sessionId,
      initialMessages: [] as never[],
      activeTaskOnServer: false,
      switchSession: () => {},
      createSession: () => {},
      removeSession: async () => {},
      refreshSessions: async () => {},
      markSessionActive: () => {},
    }),
    [sessionId],
  );

  return (
    <SessionContext.Provider value={sessionValue}>
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-border">
          <p className="text-xs text-muted truncate">
            {projectTitle || "Slides Agent"}
          </p>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatThread />
        </div>
      </div>
    </SessionContext.Provider>
  );
}
