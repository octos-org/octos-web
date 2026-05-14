import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSession } from "@/runtime/session-context";
import { eventMatchesScope } from "@/runtime/event-scope";

/**
 * Single chat-layout-level spinner for in-flight tool work.
 *
 * Mounted once by `ChatThreadV2` (lifted out of `ThreadAssistantBubble`
 * so spawn_only background tasks whose progress arrives AFTER
 * `turn/completed` still surface). Subscribes to:
 *
 *   - `crew:tool_progress` (dispatched by `ui-protocol-event-router.ts`
 *     for `tool/started`, `tool/progress`, and `tool/completed`).
 *     Terminal frames (`detail.terminal === true`, set by the router on
 *     `tool/completed`) CLEAR the spinner — for spawn_only the LLM
 *     `crew:thinking false` has already fired before the background
 *     task starts emitting, so we can't rely on it to clear the row.
 *   - `crew:thinking` `{ thinking: false }` — clears the spinner only
 *     when the event's `turnId` matches the in-flight progress's
 *     `turnId`. Without this guard a subsequent normal turn's
 *     `turn/completed` would hide a still-running background task's
 *     spinner.
 *
 * State is also reset on `(currentSessionId, historyTopic)` change so
 * a session switch doesn't carry a stale spinner over.
 */
interface ToolProgressState {
  tool: string;
  message: string;
  /** Originating turn_id — used to scope `crew:thinking` clears so an
   *  unrelated LLM turn's completion doesn't blow away a still-running
   *  spawn_only background task's spinner. */
  turnId?: string;
}

export function ToolProgressIndicator() {
  const { currentSessionId, historyTopic } = useSession();
  const [progress, setProgress] = useState<ToolProgressState | null>(null);

  // Reset progress when session/topic changes so a stale spinner from
  // session A doesn't bleed into session B. The router dispatches
  // scoped events, so events for the OLD session are dropped at
  // `eventMatchesScope` — but the previously-rendered state survives
  // unless we explicitly clear it here.
  useEffect(() => {
    setProgress(null);
  }, [currentSessionId, historyTopic]);

  useEffect(() => {
    function onProgress(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      // `tool/completed` (and spawn_only `task/updated` completed/
      // failed/errored) -> router dispatches with `terminal: true`.
      // The spinner clears immediately rather than displaying the
      // "done"/"error" message indefinitely (spawn_only
      // `crew:thinking false` has already fired and can no longer
      // clean up).
      //
      // Terminal frames are scoped by `turnId`: a completion for an
      // UNRELATED concurrent tool call in the same session must not
      // blow away the spinner of the still-running call we're
      // currently displaying. Falls back to "any terminal clears"
      // when either side lacks a turnId (legacy server-frame
      // compatibility).
      if (detail.terminal === true) {
        setProgress((prev) => {
          if (!prev) return prev;
          if (prev.turnId && detail.turnId && prev.turnId !== detail.turnId) {
            return prev;
          }
          return null;
        });
        return;
      }
      setProgress({
        tool: detail.tool,
        message: detail.message,
        turnId: detail.turnId,
      });
    }
    function onThinking(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      // Clear progress when thinking stops AND the completed turn is
      // the one that owns the in-flight progress. Pre-fix this was a
      // bare `!detail.thinking` check — a subsequent normal turn's
      // `turn/completed` would clear a still-running background
      // task's spinner from an earlier turn.
      if (detail.thinking) return;
      setProgress((prev) => {
        if (!prev) return prev;
        // If we don't know either turnId we fall back to the legacy
        // "any thinking-false clears" behaviour for compatibility with
        // server frames that don't carry `turnId`.
        if (prev.turnId && detail.turnId && prev.turnId !== detail.turnId) {
          return prev;
        }
        return null;
      });
    }
    window.addEventListener("crew:tool_progress", onProgress);
    window.addEventListener("crew:thinking", onThinking);
    return () => {
      window.removeEventListener("crew:tool_progress", onProgress);
      window.removeEventListener("crew:thinking", onThinking);
    };
  }, [currentSessionId, historyTopic]);

  if (!progress) return null;

  // Strip [info]/[debug]/[warn] prefixes from tool progress messages
  const cleanMessage = progress.message.replace(/^\[(info|debug|warn|error)\]\s*/i, "");

  return (
    <div data-testid="tool-progress" className="flex items-center gap-2 px-4 py-1 text-xs text-muted">
      <Loader2 size={12} className="animate-spin text-accent" />
      <span className="text-zinc-400">{progress.tool}:</span>
      <span>{cleanMessage}</span>
    </div>
  );
}
