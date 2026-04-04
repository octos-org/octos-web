/**
 * SSE-to-store bridge.
 *
 * Replaces the assistant-ui ChatModelAdapter generator pattern.
 * On user send, writes user message to the store, starts an SSE stream
 * via StreamManager, and routes every SSE event into the message store.
 *
 * File events that arrive after `done` still update the message.
 */

import * as StreamManager from "./stream-manager";
import * as MessageStore from "@/store/message-store";
import { API_BASE } from "@/lib/constants";
import { getToken } from "@/api/client";
import { getMessages as fetchSessionMessages } from "@/api/sessions";

// ---------------------------------------------------------------------------
// Helpers (shared with the old adapter, kept local)
// ---------------------------------------------------------------------------

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

function stripThink(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const openIdx = result.lastIndexOf("<think>");
  if (openIdx !== -1 && result.indexOf("</think>", openIdx) === -1) {
    result = result.slice(0, openIdx);
  }
  return result.trim();
}

function clean(text: string): string {
  return stripToolProgress(stripThink(text));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendOptions {
  sessionId: string;
  text: string;
  media: string[];
  /** Called once the session should appear in the sidebar. */
  onSessionActive?: (firstMessage: string) => void;
  /** Called when the assistant response is complete. */
  onComplete?: () => void;
}

/**
 * Send a user message and wire the resulting SSE stream into the message store.
 *
 * Returns immediately. The store is updated reactively as events arrive.
 */
export function sendMessage(opts: SendOptions): void {
  const { sessionId, text, media, onSessionActive, onComplete } = opts;
  const abortController = new AbortController();
  const abortSignal = abortController.signal;

  // 1. Write user message to store
  MessageStore.addMessage(sessionId, {
    role: "user",
    text,
    files: [],
    toolCalls: [],
    status: "complete",
  });

  // Notify sidebar
  onSessionActive?.(text);

  // 2. Start SSE stream
  const streamStatus = StreamManager.startStream(sessionId, text, media);

  // 3. Create the assistant message placeholder
  const assistantMsgId = MessageStore.addMessage(sessionId, {
    role: "assistant",
    text: "",
    files: [],
    toolCalls: [],
    status: "streaming",
  });

  // 4. Subscribe to events and route into the store
  let rawText = "";
  let toolCallCounter = 0;
  const toolCalls = new Map<
    string,
    { id: string; name: string; status: "running" | "complete" | "error" }
  >();
  /** Maps tool name to the most recent toolCall key (for tool_end matching). */
  const activeToolByName = new Map<string, string>();

  const handleEvent = (evt: StreamManager.StreamEvent) => {
    const event = evt.raw;

    switch (event.type) {
      case "token":
        rawText += event.text;
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          text: clean(rawText),
        });
        break;

      case "replace":
        rawText = event.text;
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          text: clean(rawText),
        });
        break;

      case "tool_start": {
        const key = `tc_${++toolCallCounter}`;
        const tcId = `tc_${event.tool}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        toolCalls.set(key, { id: tcId, name: event.tool, status: "running" });
        activeToolByName.set(event.tool, key);
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          toolCalls: Array.from(toolCalls.values()),
        });
        break;
      }

      case "tool_end": {
        const key = activeToolByName.get(event.tool);
        const tc = key ? toolCalls.get(key) : undefined;
        if (tc) tc.status = event.success ? "complete" : "error";
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          toolCalls: Array.from(toolCalls.values()),
        });
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
        if (event.path && event.filename) {
          const caption = event.caption || "";

          // Find the right message to attach to
          let targetMsgId = assistantMsgId;
          if (event.tool_call_id) {
            const msgs = MessageStore.getMessages(sessionId);
            const match = msgs.find((m) =>
              m.toolCalls.some((tc) => tc.id === event.tool_call_id),
            );
            if (match) targetMsgId = match.id;
          }

          MessageStore.appendFile(sessionId, targetMsgId, {
            filename: event.filename,
            path: event.path,
            caption,
          });

          // crew:file DOM event is dispatched by StreamManager — no need to duplicate here
        }
        break;
      }

      case "task_status": {
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { task: event.task, sessionId },
          }),
        );
        break;
      }

      case "done": {
        if (event.content) {
          rawText = event.content;
        }
        const finalText = clean(rawText);
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          text: finalText,
          status: "complete",
        });

        if (event.model || event.tokens_in || event.tokens_out) {
          window.dispatchEvent(
            new CustomEvent("crew:message_meta", {
              detail: {
                model: event.model || "",
                tokens_in: event.tokens_in || 0,
                tokens_out: event.tokens_out || 0,
                duration_s: event.duration_s || 0,
                sessionId,
                messageId: assistantMsgId,
              },
            }),
          );
        }

        // Clear thinking state
        window.dispatchEvent(
          new CustomEvent("crew:thinking", {
            detail: { thinking: false, iteration: 0, sessionId },
          }),
        );

        // Start polling for background task results (file deliveries, notifications)
        if (event.has_bg_tasks) {
          pollForBackgroundResults(sessionId, assistantMsgId, abortSignal);
          // Notify TaskStatusIndicator to start polling /api/sessions/{id}/tasks
          window.dispatchEvent(
            new CustomEvent("crew:bg_tasks", { detail: { sessionId } }),
          );
        }

        onComplete?.();
        break;
      }

      case "error": {
        const errMsg = event.message || "Agent error";
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          text: `Error: ${errMsg}`,
          status: "error",
        });
        window.dispatchEvent(
          new CustomEvent("crew:thinking", {
            detail: { thinking: false, iteration: 0, sessionId },
          }),
        );
        onComplete?.();
        break;
      }

      case "stream_end":
        break;
    }
  };

  // For queued messages, wait for the fresh stream before subscribing
  if (streamStatus === "queued") {
    StreamManager.waitForNewStream(sessionId).then(() => {
      const unsub = StreamManager.subscribeNew(sessionId, handleEvent);
      if (unsub) setupCleanup(sessionId, assistantMsgId, unsub, rawText, onComplete, abortController);
    });
  } else {
    const unsub = StreamManager.subscribe(sessionId, handleEvent);
    if (unsub) setupCleanup(sessionId, assistantMsgId, unsub, rawText, onComplete, abortController);
  }
}

/** Unsubscribe when stream ends and poll if no content arrived. */
function setupCleanup(
  sessionId: string,
  assistantMsgId: string,
  _unsub: () => void,
  _rawText: string,
  _onComplete?: () => void,
  _abortController?: AbortController,
): void {
  // The subscriber is automatically cleaned up when the stream ends
  // (StreamManager clears subscribers). We also listen for stream_state
  // to handle the case where the stream ends without a done event.
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.sessionId === sessionId && !detail.active) {
      window.removeEventListener("crew:stream_state", handler);
      _unsub();

      // If the message is still streaming (no done event received), check if we got content
      const msgs = MessageStore.getMessages(sessionId);
      const assistantMsg = msgs.find((m) => m.id === assistantMsgId);
      if (assistantMsg && assistantMsg.status === "streaming") {
        if (assistantMsg.text) {
          MessageStore.updateMessage(sessionId, assistantMsgId, { status: "complete" });
          _onComplete?.();
        } else {
          // No content — poll for response
          pollForResponse(sessionId, assistantMsgId, _abortController?.signal).then(() => _onComplete?.());
        }
      }
    }
  };
  window.addEventListener("crew:stream_state", handler);
}

/**
 * Poll for background task results after SSE `done`.
 *
 * Background tasks (spawn_only) may deliver files or status notifications
 * after the main agent loop finishes. This polls the session messages API
 * to catch those deliveries (up to 10 minutes, every 2 seconds).
 */
async function pollForBackgroundResults(
  sessionId: string,
  lastMsgId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const pollStart = new Date().toISOString();

  for (let i = 0; i < 300; i++) {
    if (abortSignal?.aborted) return;
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const messages = await fetchSessionMessages(sessionId);

      // Find messages newer than when polling started
      const newMsgs = messages.filter(
        (m) => m.timestamp && m.timestamp > pollStart,
      );

      for (const msg of newMsgs) {
        // File delivery — message has media paths
        if (msg.media && msg.media.length > 0) {
          for (const filePath of msg.media) {
            const filename = filePath.split("/").pop() || "file";
            MessageStore.appendFile(sessionId, lastMsgId, {
              filename,
              path: filePath,
              caption: msg.content || "",
            });
          }
          // Dispatch for toast + media panel
          const fileUrl = `${API_BASE}/api/files/${encodeURIComponent(msg.media[0])}`;
          window.dispatchEvent(
            new CustomEvent("crew:file", {
              detail: {
                fileUrl,
                filename: msg.media[0].split("/").pop() || "file",
                caption: msg.content || "",
                sessionId,
              },
            }),
          );
        }

        // Status notification (success/failure markers) — stop polling
        if (msg.content?.startsWith("\u2713") || msg.content?.startsWith("\u2717")) {
          return;
        }
      }
    } catch {
      // poll failed, keep trying
    }
  }
}

/** Poll for a response if the stream ended without content. */
async function pollForResponse(
  sessionId: string,
  assistantMsgId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if (abortSignal?.aborted) return;
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const token = getToken();
      const resp = await fetch(
        `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=3`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (resp.ok) {
        const msgs = (await resp.json()) as { role: string; content: string }[];
        const lastAssistant = [...msgs]
          .reverse()
          .find((m) => m.role === "assistant" && m.content.length > 20);
        if (lastAssistant) {
          MessageStore.updateMessage(sessionId, assistantMsgId, {
            text: lastAssistant.content,
            status: "complete",
          });
          return;
        }
      }
    } catch {
      // keep polling
    }
  }
  // Give up
  MessageStore.updateMessage(sessionId, assistantMsgId, {
    text: "No response received.",
    status: "error",
  });
}
