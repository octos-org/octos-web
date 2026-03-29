import { useMemo, useCallback } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from "@assistant-ui/react";
import { createOctosAdapter } from "@/runtime/octos-adapter";
import { Thread } from "@/components/thread";
import { SessionContext } from "@/runtime/session-context";

interface Props {
  sessionId: string;
  projectTitle?: string;
}

export function SlidesChat({ sessionId, projectTitle }: Props) {
  const getSessionId = useCallback(() => sessionId, [sessionId]);
  const noop = useCallback(async () => {}, []);
  const noopSync = useCallback(() => {}, []);
  const getPendingMedia = useCallback(() => [] as string[], []);

  const adapter = useMemo(
    () => createOctosAdapter(getSessionId, noop, getPendingMedia, noopSync),
    [getSessionId, noop, getPendingMedia, noopSync],
  );

  const runtime = useLocalRuntime(adapter);

  const sessionValue = useMemo(
    () => ({
      sessions: [],
      currentSessionId: sessionId,
      initialMessages: [] as never[],
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
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex flex-col h-full">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs text-muted truncate">
              {projectTitle || "Slides Agent"}
            </p>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <Thread />
          </div>
        </div>
      </AssistantRuntimeProvider>
    </SessionContext.Provider>
  );
}
