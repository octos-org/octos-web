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
    //
    // Codex BLOCK D: previous version (a) omitted `historyTopic`, so
    // the scaffold turn missed the slides-scoped topic the embedded
    // chat listens on, and (b) flipped `scaffolded: true` inside
    // onComplete unconditionally — onComplete also fires for
    // `turn/error`, which made every error look like success. Now we
    // pass the slug-scoped topic, finalize success only on a
    // SUCCESS lifecycle signal (`turn/completed` without an attached
    // error), and reset the started ref + surface `scaffoldError` on
    // failure so the user can retry.
    // The WS bridge fires `bridgeSend.onComplete` for BOTH
    // `turn/completed` AND `turn/error`, so we cannot use onComplete
    // alone as a success signal. The event router separately
    // dispatches `crew:turn_error` for the error case (see
    // `ui-protocol-event-router.ts::handleTurnError`); track whether
    // one arrived for this session+turn and gate the `scaffolded`
    // flip on its absence.
    let sawTurnError = false;
    const scaffoldTopic = `slides ${slug}`;
    const handleTurnError = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId && detail.sessionId !== sessionId) return;
      sawTurnError = true;
    };
    if (typeof window !== "undefined") {
      window.addEventListener("crew:turn_error", handleTurnError);
    }
    bridgeSend({
      sessionId,
      historyTopic: scaffoldTopic,
      text: `/new slides ${slug}`,
      media: [],
      onComplete: () => {
        if (typeof window !== "undefined") {
          window.removeEventListener("crew:turn_error", handleTurnError);
        }
        if (sawTurnError) {
          // Failure path: reset the started ref so a retry is
          // possible and DO NOT flip `scaffolded: true`. The error
          // bubble in the embedded chat already surfaces the
          // failure to the user; we just keep the editor gate
          // closed until retry succeeds.
          scaffoldStartedRef.current = false;
          return;
        }
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
