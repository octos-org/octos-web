import { useEffect, useMemo, useRef } from "react";

import { ChatThread } from "@/components/chat-thread";
import { SessionContext, useModeState } from "@/runtime/session-context";
import { ScopedRuntimeBridge } from "@/runtime/runtime-provider";
import { sendMessage as bridgeSend } from "@/runtime/ui-protocol-send";
import * as ThreadStore from "@/store/thread-store";

import { buildSlidesSlug, waitForSlidesScaffold } from "../api";
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

    // Codex round-2 BLOCK D: persist `slug` BEFORE issuing the
    // scaffold turn. The embedded `ChatThread` reads
    // `useThreads(sessionId, historyTopic)` and `historyTopic` is
    // computed from `project.slug` — without the pre-save the
    // rendered context stays root-topic while the scaffold turn (and
    // any `turn/error` bubble) lands on `slides <slug>`, invisible
    // to the user. Pre-saving the slug also lines up the storage
    // with the topic the embedded chat already listens to once it
    // re-renders for the slug change, so a failed scaffold's error
    // bubble appears next to the retry affordance.
    // We also clear any stale `scaffoldError` so retries don't
    // surface the previous failure once the new turn is in flight.
    save({ slug, scaffoldError: undefined });

    // Issue #112.2: pre-fix this POSTed to `/api/chat`, the retired
    // SSE chat transport. Route the scaffold prompt through the WS
    // bridge via `bridgeSend` — same path the user composer uses, so
    // the slides scope's bridge handles the turn lifecycle natively.
    //
    // Codex round-2 BLOCK D: `bridgeSend.onComplete` fires on
    //   - `turn/completed` (genuine success),
    //   - `turn/error` (server rejected the turn),
    //   - bridge-start failure / RPC failure / connection drop
    //     (transport-level failures that NEVER dispatched
    //     `crew:turn_error`).
    // Absence of `crew:turn_error` is therefore NOT a success
    // signal. Switch to a positive on-disk artifact check:
    // `waitForSlidesScaffold` polls `slides/<slug>/{script.js,
    // memory.md, changelog.md}` — the files the server-side scaffold
    // task always persists on success. If the artifact never lands,
    // surface `scaffoldError` so SlidesChat / the editor gate can
    // prompt a retry, and reset `scaffoldStartedRef` so the next
    // effect run re-issues the scaffold.
    const scaffoldTopic = `slides ${slug}`;
    bridgeSend({
      sessionId,
      historyTopic: scaffoldTopic,
      text: `/new slides ${slug}`,
      media: [],
      onComplete: () => {
        void (async () => {
          try {
            await waitForSlidesScaffold({ sessionId, slug });
            save({ scaffolded: true, slug, scaffoldError: undefined });
          } catch (err) {
            scaffoldStartedRef.current = false;
            save({
              scaffolded: false,
              slug,
              scaffoldError:
                err instanceof Error
                  ? err.message
                  : "Slides scaffold did not complete; please retry.",
            });
          }
        })();
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
