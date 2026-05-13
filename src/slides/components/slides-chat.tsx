import { useEffect, useMemo, useRef } from "react";

import { ChatThread } from "@/components/chat-thread";
import { SessionContext, useModeState } from "@/runtime/session-context";
import { ScopedRuntimeBridge } from "@/runtime/runtime-provider";
import { sendMessage as bridgeSend } from "@/runtime/ui-protocol-send";
import * as ThreadStore from "@/store/thread-store";

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
    void ThreadStore.loadHistory(sessionId, historyTopic);
  }, [historyTopic, sessionId]);

  useEffect(() => {
    if (
      !projectId ||
      !projectTitle ||
      projectScaffolded ||
      scaffoldStartedRef.current
    ) {
      return;
    }

    const slug = projectSlug || buildSlidesSlug(projectTitle, projectId);
    scaffoldStartedRef.current = true;

    // Issue #112.2: pre-fix this POSTed to `/api/chat`, the retired
    // SSE chat transport. Route the scaffold prompt through the WS
    // bridge via `bridgeSend` — same path the user composer uses, so
    // the slides scope's bridge handles the turn lifecycle natively.
    // Persistence success isn't waited on inline (the bridge fires
    // `turn/completed` async); we mark scaffolded optimistically so
    // the editor unblocks. If the scaffold turn errors the user
    // sees it surface as a normal assistant error bubble in the
    // embedded chat — same recovery path as a manual prompt.
    bridgeSend({
      sessionId,
      text: `/new slides ${slug}`,
      media: [],
      onComplete: () => {
        save({ scaffolded: true, slug });
      },
    });
  }, [
    projectId,
    projectScaffolded,
    projectSlug,
    projectTitle,
    save,
    sessionId,
  ]);

  const { queueMode, adaptiveMode } = useModeState();

  const sessionValue = useMemo(
    () => ({
      sessions: [],
      currentSessionId: sessionId,
      historyTopic,
      currentSessionTitle: project?.title || "Slides Agent",
      currentSessionStats: null,
      initialMessages: [] as never[],
      activeTaskOnServer: false,
      queueMode,
      adaptiveMode,
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
    [adaptiveMode, historyTopic, project?.title, queueMode, sessionId],
  );

  return (
    <SessionContext.Provider value={sessionValue}>
      <ScopedRuntimeBridge>
        <div className="flex flex-col h-full">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs text-muted truncate">
              {project?.title || "Slides Agent"}
            </p>
            <SlidesTaskStatusIndicator
              sessionId={sessionId}
              historyTopic={historyTopic}
            />
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ChatThread hideFileOnlyAssistantMessages />
          </div>
        </div>
      </ScopedRuntimeBridge>
    </SessionContext.Provider>
  );
}
