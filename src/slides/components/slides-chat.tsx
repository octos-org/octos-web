import { useEffect, useMemo, useRef } from "react";

import { getToken } from "@/api/client";
import { ChatThread } from "@/components/chat-thread";
import { API_BASE } from "@/lib/constants";
import { SessionContext } from "@/runtime/session-context";
import * as MessageStore from "@/store/message-store";

import { slugifySlidesTitle } from "../api";
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

  // Load history for this session
  useEffect(() => {
    MessageStore.loadHistory(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!projectId || !projectTitle || projectScaffolded || scaffoldStartedRef.current) {
      return;
    }

    const slug = projectSlug || slugifySlidesTitle(projectTitle);
    const token = getToken();
    const abort = new AbortController();
    scaffoldStartedRef.current = true;

    void fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        message: `/new slides ${slug}`,
        session_id: sessionId,
      }),
      signal: abort.signal,
    })
      .then((resp) => {
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
      currentSessionTitle: project?.title || "Slides Agent",
      currentSessionStats: null,
      initialMessages: [] as never[],
      activeTaskOnServer: false,
      setServerTaskActive: () => {},
      renameSession: () => {},
      updateSessionStats: () => {},
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
            {project?.title || "Slides Agent"}
          </p>
          <SlidesTaskStatusIndicator sessionId={sessionId} />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatThread />
        </div>
      </div>
    </SessionContext.Provider>
  );
}
