import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import type { ThreadMessage, ThreadToolCall } from "@/store/thread-store";

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
 * tool calls in the bubble (with the tool name + status icon). The
 * caller (`ThreadAssistantBubble`) gates the mount on the bubble
 * having at least one tool call with progress entries — the
 * indicator itself only renders if it has a progress entry to
 * display, but the caller-side gate avoids mounting / unmounting on
 * bubbles that never had a tool call at all.
 *
 * **Spinner gating (2026-05-14 follow-up)**: the leading icon's
 * animation is tied to the status of the tool call that owns the
 * latest progress entry:
 *
 *   - `running`  → animated `Loader2` (the live spinner)
 *   - `complete` → static `Check` (✓)
 *   - `error`    → static `X` (✗)
 *
 * Without this gate the `Loader2` kept animating indefinitely after
 * `tool/completed` / `task/updated:completed` flipped the chip's
 * status — visually contradicting the chip-list which had already
 * settled (no pulse). The row text remains visible so the user can
 * read the last activity message; only the leading icon changes.
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
  //
  // We also retain the OWNING tool call so the leading icon can
  // reflect that call's terminal status — a stale "running" Loader2
  // on a finished call was the spinner-doesn't-stop bug reported on
  // mini5 for `run_pipeline`.
  let latestTool: string | null = null;
  let latestMessage: string | null = null;
  let latestStatus: ThreadToolCall["status"] | null = null;
  let latestTs = -Infinity;
  for (const tc of message.toolCalls) {
    for (const entry of tc.progress) {
      if (entry.ts >= latestTs) {
        latestTs = entry.ts;
        latestTool = tc.name || "tool";
        latestMessage = entry.message;
        latestStatus = tc.status;
      }
    }
  }
  if (latestTool === null || latestMessage === null || latestStatus === null)
    return null;

  // Strip [info]/[debug]/[warn] prefixes from tool progress messages
  const cleanMessage = latestMessage.replace(
    /^\[(info|debug|warn|error)\]\s*/i,
    "",
  );

  // Pick the leading icon by the owning tool call's status. Only
  // `running` deserves the animated `Loader2`; terminal states get a
  // static glyph so the row stops "spinning" the moment the tool
  // settles. This is the fix for the spawn_only run_pipeline bug
  // observed on mini5 (2026-05-14): the bubble correctly said
  // "completed" but the spinner kept animating because the gate used
  // `progress.length > 0` rather than `status === "running"`.
  let leadingIcon: ReactNode;
  if (latestStatus === "running") {
    // Three color-cycling bouncing balls; same `data-testid` the
    // legacy `Loader2` had, so existing unit + e2e specs that target
    // `[data-testid='tool-progress-spinner']` still resolve the
    // animated row indicator.
    // codex PR #147 review (MINOR 1, 2026-05-22): the outer wrapper
    // carries `role="img"` + `aria-label` so screen readers announce
    // "running"; `aria-hidden` is moved to the individual visual balls
    // so the decorative shapes are hidden but the accessible name still
    // exposes. Previously the wrapper had BOTH `aria-label` AND
    // `aria-hidden="true"` — the hidden flag won, so AT users got
    // nothing.
    leadingIcon = (
      <span
        data-testid="tool-progress-spinner"
        className="inline-flex items-center gap-[3px]"
        role="img"
        aria-label="running"
      >
        <span
          aria-hidden="true"
          className="tool-ball block h-1.5 w-1.5 rounded-full bg-accent"
          style={{ animationDelay: "0ms" }}
        />
        <span
          aria-hidden="true"
          className="tool-ball block h-1.5 w-1.5 rounded-full bg-accent/70"
          style={{ animationDelay: "150ms" }}
        />
        <span
          aria-hidden="true"
          className="tool-ball block h-1.5 w-1.5 rounded-full bg-accent/40"
          style={{ animationDelay: "300ms" }}
        />
      </span>
    );
  } else if (latestStatus === "complete") {
    leadingIcon = (
      <Check
        size={12}
        className="text-emerald-400"
        data-testid="tool-progress-complete-icon"
        aria-label="complete"
      />
    );
  } else {
    // status === "error"
    leadingIcon = (
      <X
        size={12}
        className="text-red-400"
        data-testid="tool-progress-error-icon"
        aria-label="error"
      />
    );
  }

  return (
    <div
      data-testid="tool-progress"
      data-tool-status={latestStatus}
      className="mt-1.5 flex items-center gap-2 px-1 py-0.5 text-xs text-muted"
    >
      {leadingIcon}
      <span className="text-zinc-400">{latestTool}:</span>
      <span>{cleanMessage}</span>
    </div>
  );
}
