import { Loader2 } from "lucide-react";
import type { ThreadMessage } from "@/store/thread-store";

/**
 * Inline spinner row for in-flight tool work.
 *
 * **Anchor (2026-05-14)**: this indicator is mounted INSIDE
 * `ThreadAssistantBubble`. The previous chat-layout-level lift
 * (commit 86fb70e) tried to surface spawn_only spinner heartbeats
 * after `turn/completed` by rendering the indicator above the
 * composer; that caused a recurring UX bug where the indicator sat
 * detached from its bubble above the input prompt for the entire
 * duration of long-running tools — for `run_pipeline` ~25 minutes of
 * a phantom "running" badge near the input. Commit `1a20b7a`
 * (immutable tool-call updates) made the bubble re-render on every
 * heartbeat, so a per-bubble indicator + the bubble's own progress
 * chip list (rendered by `ToolCallBubble`) together provide the
 * spawn_only liveness signal without the detached-from-bubble bug.
 *
 * **Pure derivation, no window events**: previous designs subscribed
 * to `crew:tool_progress` to populate internal state. That was
 * brittle: the indicator is gated on `message.toolCalls.length > 0`
 * (only mounts after `tool/started` has added a call), so the very
 * first events would fire BEFORE the indicator's effect attached its
 * listener and be missed. Reading directly from `message.toolCalls`
 * sidesteps the race — every progress entry that landed in the store
 * via `appendToolProgress` is visible to this render.
 *
 * **Display rule**: show the most recent `progress` entry across all
 * tool calls in the bubble (with the tool name + spinner icon). The
 * caller (`ThreadAssistantBubble`) gates the mount on the bubble
 * having at least one tool call with progress entries — the
 * indicator itself only renders if it has a progress entry to
 * display, but the caller-side gate avoids mounting / unmounting on
 * bubbles that never had a tool call at all.
 */
interface ToolProgressIndicatorProps {
  /** ThreadMessage whose `toolCalls` drive the indicator. The bubble
   *  passes its own `message` prop. */
  message: ThreadMessage;
}

export function ToolProgressIndicator({ message }: ToolProgressIndicatorProps) {
  // Find the latest progress entry across all tool calls in the
  // bubble. We pick the entry with the highest `ts` so a tool that
  // finished early stays beneath a still-running tool whose heartbeat
  // is more recent.
  let latestTool: string | null = null;
  let latestMessage: string | null = null;
  let latestTs = -Infinity;
  for (const tc of message.toolCalls) {
    for (const entry of tc.progress) {
      if (entry.ts >= latestTs) {
        latestTs = entry.ts;
        latestTool = tc.name || "tool";
        latestMessage = entry.message;
      }
    }
  }
  if (latestTool === null || latestMessage === null) return null;

  // Strip [info]/[debug]/[warn] prefixes from tool progress messages
  const cleanMessage = latestMessage.replace(
    /^\[(info|debug|warn|error)\]\s*/i,
    "",
  );

  return (
    <div
      data-testid="tool-progress"
      className="mt-1.5 flex items-center gap-2 px-1 py-0.5 text-xs text-muted"
    >
      <Loader2 size={12} className="animate-spin text-accent" />
      <span className="text-zinc-400">{latestTool}:</span>
      <span>{cleanMessage}</span>
    </div>
  );
}
