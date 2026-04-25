/**
 * Pure visibility helpers for chat-thread message rendering.
 *
 * Lives in `lib/` so unit tests can import these without pulling in the
 * full chat-thread tree (which transitively loads CSS via the markdown
 * renderer's KaTeX import).
 */

import type { Message } from "@/store/message-store";

/**
 * Assistant message that is visible only as inline file attachments.
 *
 * Used by topic surfaces (e.g. slides delivery) that show the file panel
 * separately and want to suppress the duplicate file-only assistant bubble
 * in the conversation timeline.
 */
export function isFileOnlyAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    !message.text.trim() &&
    message.files.length > 0 &&
    message.toolCalls.length === 0
  );
}

/**
 * Empty completed assistant bubble — should NOT render.
 *
 * Anomaly 2: a `done` event with empty content (or a queued M9 placeholder
 * whose stream was canceled before any token arrived) leaves an assistant
 * message with `text=""`, `files=[]`, `toolCalls=[]` and `status="complete"`.
 * The AssistantBubble shell still renders MessageMetaInline, so the user
 * sees a bubble with only a timestamp string. Filter those out at the list
 * level so they never reach AssistantBubble.
 *
 * Streaming bubbles (typing dots) and task_anchor placeholders are exempt:
 * task_anchor has its own data-testid and intentionally renders without
 * text; streaming bubbles still need the dots to confirm liveness.
 */
export function isEmptyCompletedAssistantBubble(message: Message): boolean {
  if (message.role !== "assistant") return false;
  if (message.kind === "task_anchor") return false;
  if (message.status === "streaming") return false;
  return (
    !message.text.trim() &&
    message.files.length === 0 &&
    message.toolCalls.length === 0
  );
}
