import { useEffect, useMemo, useRef } from "react";

import { buildApiHeaders } from "@/api/client";
import { ChatThread } from "@/components/chat-thread";
import { API_BASE } from "@/lib/constants";
import { SessionContext } from "@/runtime/session-context";
import * as MessageStore from "@/store/message-store";

import { buildSlidesSlug } from "../api";
import { useSlides } from "../context/slides-context";
import { SlidesTaskStatusIndicator } from "./slides-task-status-indicator";

interface Props {
  sessionId: string;
}

export function SlidesChat({ sessionId }: Props) {
  const { project, save } = useSlides();
  const scaffoldStartedRef = useRef(false);
  const projectId = project?.id;
  const projectTitle = project?.title;
  const projectSlug = project?.slug;
  const projectScaffolded = project?.scaffolded;
  const historyTopic = projectSlug ? `slides ${projectSlug}` : undefined;

  // Load history for this session
  useEffect(() => {
    void MessageStore.loadHistory(sessionId, historyTopic);
  }, [historyTopic, sessionId]);

  useEffect(() => {
    if (!projectId || !projectTitle || projectScaffolded || scaffoldStartedRef.current) {
      return;
    }

    const slug = projectSlug || buildSlidesSlug(projectTitle, projectId);
    const abort = new AbortController();
    scaffoldStartedRef.current = true;

    void fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildApiHeaders(),
      },
      body: JSON.stringify({
        message: `/new slides ${slug}`,
        session_id: sessionId,
      }),
      signal: abort.signal,
    })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        save({ scaffolded: true, slug });
      })
      .catch(() => {
        scaffoldStartedRef.current = false;
      });

    return () => abort.abort();
  }, [projectId, projectScaffolded, projectSlug, projectTitle, save, sessionId]);

  const sessionValue = useMemo(
    () => ({
      sessions: [],
      currentSessionId: sessionId,
      historyTopic,
      currentSessionTitle: project?.title || "Slides Agent",
      currentSessionStats: null,
      initialMessages: [] as never[],
      activeTaskOnServer: false,
      setServerTaskActive: () => {},
      renameSession: () => {},
      updateSessionStats: () => {},
      switchSession: () => {},
      goBack: async () => false,
      createSession: () => sessionId,
      removeSession: async () => {},
      refreshSessions: async () => {},
      markSessionActive: () => {},
    }),
    [historyTopic, project?.title, sessionId],
  );

  return (
    <SessionContext.Provider value={sessionValue}>
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-border">
          <p className="text-xs text-muted truncate">
            {project?.title || "Slides Agent"}
          </p>
          <SlidesTaskStatusIndicator sessionId={sessionId} />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatThread hideFileOnlyAssistantMessages />
        </div>
      </div>
    </SessionContext.Provider>
  );
}
