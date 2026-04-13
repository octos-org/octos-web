import type {
  ChatModelAdapter,
  ChatModelRunResult,
} from "@assistant-ui/react";
import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import * as StreamManager from "./stream-manager";
import { dispatchCrewFileEvent } from "./file-events";

/** Strip tool progress lines and status composer lines from text. */
function stripToolProgress(text: string): string {
  const lines = text.split("\n");
  const cleaned = lines.filter((line) => {
    const t = line.trim();
    if (/^[✓✗⚙📄]\s*`/u.test(t)) return false;
    if (t === "Processing") return false;
    if (/^via\s+\S+\s+\(/.test(t)) return false;
    if (/^\d+s$/.test(t)) return false;
    return true;
  });
  return cleaned.join("\n").trim();
}

/** Strip <think>...</think> blocks from streaming text. */
function stripThink(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const openIdx = result.lastIndexOf("<think>");
  if (openIdx !== -1 && result.indexOf("</think>", openIdx) === -1) {
    result = result.slice(0, openIdx);
  }
  return result.trim();
}

/** Extract text from message content parts. */
function extractText(
  msg: { content: readonly { type: string; text?: string }[] } | undefined,
): string {
  if (!msg?.content) return "";
  return msg.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof (p as { text?: string }).text === "string",
    )
    .map((p) => p.text)
    .join("");
}

export function createOctosAdapter(
  getSessionId: () => string,
  onMessageComplete?: () => void,
  getPendingMedia?: () => string[],
  onMessageSent?: (firstMessage: string) => void,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const sessionId = getSessionId();
      const lastMsg = messages[messages.length - 1];
      const userText = extractText(lastMsg);

      // Mark session as active in the sidebar immediately
      onMessageSent?.(userText);

      // Start the stream via StreamManager (survives React unmount)
      const streamStatus = StreamManager.startStream(
        sessionId,
        userText,
        getPendingMedia?.() ?? [],
      );

      // If message was queued (another stream active), wait for the new stream
      // to start before subscribing — prevents replaying the old stream's events.
      if (streamStatus === "queued") {
        await StreamManager.waitForNewStream(sessionId);
      }

      // Subscribe to events and yield results.
      // If the component unmounts (abortSignal fires), the subscription
      // stops but the stream continues in background.
      let text = "";
      let toolCallCounter = 0;
      const toolCalls = new Map<
        string,
        { toolCallId: string; toolName: string; status: string }
      >();
      /** Maps tool name to the most recent toolCall key (for tool_end matching). */
      const activeToolByName = new Map<string, string>();
      let done = false;

      // Create a queue for events from the subscriber
      const queue: StreamManager.StreamEvent[] = [];
      let resolve: (() => void) | null = null;

      // For queued messages, don't replay old events — only listen to the fresh stream.
      const subscribeFn = streamStatus === "queued"
        ? StreamManager.subscribeNew
        : StreamManager.subscribe;
      const unsub = subscribeFn(sessionId, (event) => {
        queue.push(event);
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

      if (!unsub) {
        // No stream found — shouldn't happen
        return;
      }

      try {
        while (!done) {
          // Wait for events or abort
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              resolve = r;
              // Also resolve on abort so we can exit cleanly
              abortSignal.addEventListener("abort", () => r(), { once: true });
            });
          }

          if (abortSignal.aborted) break;

          // Process all queued events
          while (queue.length > 0) {
            const { raw: event } = queue.shift()!;

            switch (event.type) {
              case "token":
                text += event.text;
                yield buildResult(stripToolProgress(stripThink(text)), toolCalls);
                break;

              case "replace":
                text = event.text;
                yield buildResult(stripToolProgress(stripThink(text)), toolCalls);
                break;

              case "tool_start": {
                const key = `tc_${++toolCallCounter}`;
                toolCalls.set(key, {
                  toolCallId: `tc_${event.tool}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  toolName: event.tool,
                  status: "running",
                });
                activeToolByName.set(event.tool, key);
                yield buildResult(text, toolCalls);
                break;
              }

              case "tool_end": {
                const key = activeToolByName.get(event.tool);
                const tc = key ? toolCalls.get(key) : undefined;
                if (tc) tc.status = event.success ? "complete" : "error";
                yield buildResult(text, toolCalls);
                break;
              }

              case "tool_progress":
                window.dispatchEvent(
                  new CustomEvent("crew:tool_progress", {
                    detail: { tool: event.tool, message: event.message, sessionId },
                  }),
                );
                break;

              case "thinking":
                window.dispatchEvent(
                  new CustomEvent("crew:thinking", {
                    detail: { thinking: true, iteration: event.iteration, sessionId },
                  }),
                );
                break;

              case "response":
                window.dispatchEvent(
                  new CustomEvent("crew:thinking", {
                    detail: { thinking: false, iteration: event.iteration, sessionId },
                  }),
                );
                break;

              case "cost_update":
                window.dispatchEvent(
                  new CustomEvent("crew:cost", { detail: { ...event, sessionId } }),
                );
                break;

              case "file": {
                const fileEvent = event as { path?: string; filename?: string; caption?: string };
                if (fileEvent.path && fileEvent.filename) {
                  const caption = fileEvent.caption ? ` — ${fileEvent.caption}` : "";
                  dispatchCrewFileEvent({
                    sessionId,
                    path: fileEvent.path,
                    filename: fileEvent.filename,
                    caption,
                  });
                }
                break;
              }

              case "done":
                if (event.content) {
                  text = stripToolProgress(stripThink(event.content));
                }
                if (event.model || event.tokens_in || event.tokens_out) {
                  window.dispatchEvent(
                    new CustomEvent("crew:message_meta", {
                      detail: {
                        model: event.model || "",
                        tokens_in: event.tokens_in || 0,
                        tokens_out: event.tokens_out || 0,
                        duration_s: event.duration_s || 0,
                        sessionId,
                      },
                    }),
                  );
                }
                yield buildResult(text, toolCalls);
                done = true;
                break;

              case "error": {
                const errMsg = (event as { message?: string }).message || "Agent error";
                text = `⚠️ Error: ${errMsg}`;
                yield buildResult(text, toolCalls);
                done = true;
                break;
              }

              case "stream_end":
                break;
            }
          }

          // Check if stream ended without done event
          if (!done && !StreamManager.isActive(sessionId) && queue.length === 0) {
            break;
          }
        }
      } finally {
        unsub();
      }

      // Strip residual tool progress lines from final text.
      if (text) {
        const cleaned = stripToolProgress(text);
        if (cleaned !== text) {
          text = cleaned;
          yield buildResult(text, toolCalls);
        }
      }

      // If stream ended without any content at all, poll for response
      if (!text) {
        for (let poll = 0; poll < 180; poll++) {
          if (abortSignal.aborted) break;
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const freshToken = getToken();
            const pollResp = await fetch(
              `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=3`,
              { headers: freshToken ? { Authorization: `Bearer ${freshToken}` } : {} },
            );
            if (pollResp.ok) {
              const pollMsgs = (await pollResp.json()) as {
                role: string;
                content: string;
              }[];
              const lastAssistant = [...pollMsgs]
                .reverse()
                .find((m) => m.role === "assistant" && m.content.length > 20);
              if (lastAssistant) {
                text = lastAssistant.content;
                yield buildResult(text, toolCalls);
                break;
              }
            }
          } catch {
            // keep polling
          }
        }
      }

      // Clear thinking state
      window.dispatchEvent(
        new CustomEvent("crew:thinking", {
          detail: { thinking: false, iteration: 0, sessionId },
        }),
      );

      onMessageComplete?.();
    },
  };
}

function buildResult(
  text: string,
  toolCalls: Map<
    string,
    { toolCallId: string; toolName: string; status: string }
  >,
): ChatModelRunResult {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        args: Record<string, never>;
        argsText: string;
      }
  > = [];

  if (text) {
    content.push({ type: "text", text });
  }

  for (const tc of toolCalls.values()) {
    content.push({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: {},
      argsText: "{}",
    });
  }

  return { content };
}
