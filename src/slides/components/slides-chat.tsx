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
  /** Codex round-3 BLOCK D.b: bumped by the editor layout's retry
   *  button after a scaffold failure. Including it in the
   *  auto-scaffold effect deps re-runs the effect even when the
   *  project still has `scaffolded: false` from the previous run. */
  retryNonce?: number;
}

export function SlidesChat({ sessionId, retryNonce = 0 }: Props) {
  const { project, save } = useSlides();
  const scaffoldStartedRef = useRef(false);
  // Codex round-4 NIT: holds the bridge-side error message captured
  // by the `crew:turn_error` listener for the active scaffold turn.
  // The `waitForSlidesScaffold` catch path preserves it instead of
  // overwriting with the generic poll-timeout message, so the user
  // sees the real server failure rather than "did not appear".
  const bridgeScaffoldErrorRef = useRef<string | null>(null);
  const projectId = project?.id;
  const projectTitle = project?.title;
  const projectSlug = project?.slug;
  const projectScaffolded = project?.scaffolded;
  const projectScaffoldError = project?.scaffoldError;
  const historyTopic = projectSlug ? `slides ${projectSlug}` : undefined;

  // Codex round-3 BLOCK D.b: when the retry button fires, the layout
  // clears `scaffoldError` and bumps `retryNonce`. Reset the
  // "already started" gate here so the effect re-issues the
  // scaffold instead of bailing out via `scaffoldStartedRef`.
  useEffect(() => {
    if (retryNonce > 0) {
      scaffoldStartedRef.current = false;
      // Stale bridge error must not leak into the next attempt's
      // poll-timeout fallback (Codex round-4 NIT).
      bridgeScaffoldErrorRef.current = null;
    }
  }, [retryNonce]);

  // Load history for this session
  useEffect(() => {
    void ThreadStore.loadHistory(sessionId, historyTopic);
  }, [historyTopic, sessionId]);

  useEffect(() => {
    // Codex round-3 BLOCK D.b: also gate on `projectScaffoldError`.
    // Without this gate, a freshly-loaded project that previously
    // failed (`scaffolded: false`, `scaffoldError: "..."`) would
    // auto-retry on every mount/hydration. The retry path
    // explicitly clears `scaffoldError` AND bumps `retryNonce`,
    // which resets `scaffoldStartedRef` above.
    if (
      !projectId ||
      !projectTitle ||
      projectScaffolded ||
      projectScaffoldError ||
      scaffoldStartedRef.current
    ) {
      return;
    }

    const slug = projectSlug || buildSlidesSlug(projectTitle, projectId);
    scaffoldStartedRef.current = true;
    // New attempt: drop any error captured during the previous turn.
    bridgeScaffoldErrorRef.current = null;

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

    // Codex round-4 NIT: the bridge dispatches `crew:turn_error` for
    // this scaffold turn with the real server error. `onComplete`
    // fires immediately after, so we capture the message into a ref
    // and prefer it over the generic poll-timeout text in the catch
    // path below.
    const scaffoldTopic = `slides ${slug}`;
    function handleTurnError(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as
        | {
            sessionId?: unknown;
            topic?: unknown;
            error?: { message?: unknown };
          }
        | undefined;
      if (!detail || detail.sessionId !== sessionId) return;
      if (typeof detail.topic === "string" && detail.topic !== scaffoldTopic) {
        return;
      }
      const message = detail.error?.message;
      if (typeof message === "string" && message.length > 0) {
        bridgeScaffoldErrorRef.current = message;
      }
    }
    window.addEventListener("crew:turn_error", handleTurnError);

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
            const bridgeError = bridgeScaffoldErrorRef.current;
            save({
              scaffolded: false,
              slug,
              // Prefer the bridge-side server error (real cause) over
              // the poll-timeout fallback when both fire.
              scaffoldError:
                bridgeError ??
                (err instanceof Error
                  ? err.message
                  : "Slides scaffold did not complete; please retry."),
            });
          } finally {
            window.removeEventListener("crew:turn_error", handleTurnError);
          }
        })();
      },
    });

    return () => {
      // Unmount before onComplete: drop the listener so it doesn't
      // outlive the effect closure.
      window.removeEventListener("crew:turn_error", handleTurnError);
    };
  }, [
    projectId,
    projectScaffolded,
    projectScaffoldError,
    projectSlug,
    projectTitle,
    retryNonce,
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
