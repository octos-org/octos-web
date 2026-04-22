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
import { displayFilenameFromPath } from "@/lib/utils";
import { getMessages as fetchSessionMessages } from "@/api/sessions";
import { dispatchCrewFileEvent } from "./file-events";
import { recordRuntimeCounter } from "./observability";
import { eventSessionId, eventTopic } from "./event-scope";

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
// Mode detection — parse /queue and /adaptive command responses
// ---------------------------------------------------------------------------

const QUEUE_MODE_RE =
  /Queue mode(?:\s+set to)?:\s*(followup|collect|steer|interrupt|speculative)/i;
const ADAPTIVE_MODE_RE = /Adaptive mode:\s*(off|hedge|lane)/i;
const ADAPTIVE_STATUS_RE =
  /^\*?\*?Adaptive Routing\*?\*?\s*\n\s*mode:\s*(off|hedge|lane)/im;
const RESET_RE = /^Reset:/i;

function detectModeUpdate(text: string, sessionId: string) {
  const detail: Record<string, unknown> = { sessionId };
  let matched = false;

  const qm = text.match(QUEUE_MODE_RE);
  if (qm) {
    detail.queueMode = qm[1].toLowerCase();
    matched = true;
  }

  const am = text.match(ADAPTIVE_MODE_RE);
  if (am) {
    detail.adaptiveMode = am[1].toLowerCase();
    matched = true;
  }

  if (!am) {
    const as = text.match(ADAPTIVE_STATUS_RE);
    if (as) {
      detail.adaptiveMode = as[1].toLowerCase();
      matched = true;
    }
  }

  if (RESET_RE.test(text)) {
    detail.queueMode = null;
    detail.adaptiveMode = null;
    matched = true;
  }

  if (matched) {
    window.dispatchEvent(new CustomEvent("crew:mode_update", { detail }));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendOptions {
  sessionId: string;
  historyTopic?: string;
  text: string;
  requestText?: string;
  media: string[];
  clientMessageId?: string;
  audioUploadMode?: "recording" | "upload";
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
  const {
    sessionId,
    historyTopic,
    text,
    requestText,
    media,
    clientMessageId = crypto.randomUUID(),
    audioUploadMode,
    onSessionActive,
    onComplete,
  } = opts;
  const abortController = new AbortController();
  const sentAt = Date.now();
  const localFiles = media.map((path) => ({
    filename: displayFilenameFromPath(path),
    path,
    caption: "",
  }));

  // 1. Write user message to store
  MessageStore.addMessage(sessionId, {
    role: "user",
    text,
    clientMessageId,
    files: localFiles,
    toolCalls: [],
    status: "complete",
  }, historyTopic);

  // Notify sidebar
  onSessionActive?.(text);

  // 2. Start SSE stream (always immediate — no client-side queuing)
  StreamManager.startStream(
    sessionId,
    requestText ?? text,
    media,
    historyTopic,
    clientMessageId,
    audioUploadMode,
  );

  // 3. Create the assistant message placeholder
  const assistantMsgId = MessageStore.addMessage(sessionId, {
    role: "assistant",
    text: "",
    responseToClientMessageId: clientMessageId,
    files: [],
    toolCalls: [],
    status: "streaming",
  }, historyTopic);

  // 4. Subscribe to events and route into the store
  bindStreamToAssistant({
    sessionId,
    assistantMsgId,
    onComplete,
    abortController,
    clientMessageId,
    sentAt,
    historyTopic,
  });
}

export function resumeSessionStream(
  sessionId: string,
  historyTopic?: string,
  onComplete?: () => void,
): void {
  const abortController = new AbortController();
  StreamManager.attachStream(sessionId, historyTopic);
  const assistantMsgId = MessageStore.ensureStreamingAssistantMessage(
    sessionId,
    "Resuming ongoing work...",
    historyTopic,
  );

  bindStreamToAssistant({
    sessionId,
    assistantMsgId,
    onComplete,
    abortController,
    sentAt: Date.now(),
    historyTopic,
  });
}

function bindStreamToAssistant({
  sessionId,
  assistantMsgId,
  onComplete,
  abortController,
  clientMessageId,
  sentAt,
  historyTopic,
}: {
  sessionId: string;
  assistantMsgId: string;
  onComplete?: () => void;
  abortController: AbortController;
  clientMessageId?: string;
  sentAt: number;
  historyTopic?: string;
}): void {
  let rawText = "";
  let toolCallCounter = 0;
  const pendingStreamError = { current: null as string | null };
  const toolCalls = new Map<
    string,
    { id: string; name: string; status: "running" | "complete" | "error" }
  >();
  /** Maps tool name to the most recent toolCall key (for tool_end matching). */
  const activeToolByName = new Map<string, string>();
  const normalizedHistoryTopic = historyTopic?.trim() || undefined;

  const handleEvent = (evt: StreamManager.StreamEvent) => {
    const event = evt.raw;
    const scopedSessionId = eventSessionId(event);
    if (scopedSessionId !== undefined && scopedSessionId !== sessionId) {
      recordRuntimeCounter("octos_session_mismatch_total", {
        surface: "sse_bridge",
      });
      return;
    }

    const scopedTopic = eventTopic(event);
    if (scopedTopic !== undefined && scopedTopic !== normalizedHistoryTopic) {
      recordRuntimeCounter("octos_topic_mismatch_total", {
        surface: "sse_bridge",
      });
      return;
    }

    switch (event.type) {
      case "token":
        rawText += event.text;
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          text: clean(rawText),
        }, historyTopic);
        break;

      case "replace":
        rawText = event.text;
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          text: clean(rawText),
          sourceToolCallId: event.tool_call_id ?? undefined,
        }, historyTopic);
        break;

      case "tool_start": {
        const key = `tc_${++toolCallCounter}`;
        const tcId =
          event.tool_call_id ||
          event.tool_id ||
          `tc_${event.tool}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        toolCalls.set(key, { id: tcId, name: event.tool, status: "running" });
        activeToolByName.set(event.tool, key);
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          toolCalls: Array.from(toolCalls.values()),
        }, historyTopic);
        break;
      }

      case "tool_end": {
        const key = activeToolByName.get(event.tool);
        const tc = key ? toolCalls.get(key) : undefined;
        if (tc) tc.status = event.success ? "complete" : "error";
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          toolCalls: Array.from(toolCalls.values()),
        }, historyTopic);
        break;
      }

      case "tool_progress":
        window.dispatchEvent(
          new CustomEvent("crew:tool_progress", {
            detail: {
              tool: event.tool,
              message: event.message,
              sessionId,
              topic: historyTopic,
            },
          }),
        );
        break;

      case "thinking":
        window.dispatchEvent(
          new CustomEvent("crew:thinking", {
            detail: {
              thinking: true,
              iteration: event.iteration,
              sessionId,
              topic: normalizedHistoryTopic,
            },
          }),
        );
        break;

      case "response":
        window.dispatchEvent(
          new CustomEvent("crew:thinking", {
            detail: {
              thinking: false,
              iteration: event.iteration,
              sessionId,
              topic: normalizedHistoryTopic,
            },
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

          const file = {
            filename: event.filename,
            path: event.path,
            caption,
          };
          MessageStore.appendFileByToolCallId(
            sessionId,
            event.tool_call_id,
            file,
            historyTopic,
          );

          dispatchCrewFileEvent({
            sessionId,
            topic: historyTopic,
            path: event.path,
            filename: event.filename,
            caption,
          });
        }
        break;
      }

      case "task_status": {
        const anchorId = MessageStore.bindBackgroundTask(
          sessionId,
          event.task,
          historyTopic,
        );
        if (anchorId) {
          window.dispatchEvent(
            new CustomEvent("crew:task_status", {
              detail: { task: event.task, sessionId, topic: historyTopic },
            }),
          );
        }
        break;
      }

      case "session_result": {
        if (event.message) {
          const previousSeq = MessageStore.getMaxHistorySeq(sessionId, historyTopic);
          const merged = MessageStore.mergeHistoryMessageIntoMessage(
            sessionId,
            assistantMsgId,
            event.message,
            historyTopic,
          );
          if (!merged) {
            MessageStore.appendHistoryMessages(sessionId, [event.message], historyTopic);
          }
          const observedSeq =
            typeof event.message.seq === "number"
              ? event.message.seq
              : MessageStore.getMaxHistorySeq(sessionId, historyTopic);
          if (observedSeq > previousSeq + 1) {
            void fetchSessionMessages(
              sessionId,
              500,
              0,
              previousSeq >= 0 ? previousSeq : undefined,
              historyTopic,
            )
              .then((messages) => {
                MessageStore.appendHistoryMessages(sessionId, messages, historyTopic);
              })
              .catch(() => {});
          }
          for (const filePath of event.message.media ?? []) {
            dispatchCrewFileEvent({
              sessionId,
              topic: historyTopic,
              path: filePath,
              filename: displayFilenameFromPath(filePath),
              caption: "",
            });
          }
        }
        break;
      }

      case "done": {
        if (event.content) {
          rawText = event.content;
        }
        const finalText = clean(rawText);
        for (const toolCall of toolCalls.values()) {
          if (toolCall.status === "running") {
            toolCall.status = "complete";
          }
        }
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          text: finalText,
          status: "complete",
          toolCalls: Array.from(toolCalls.values()),
        }, historyTopic);

        if (event.model || event.tokens_in || event.tokens_out) {
          MessageStore.setMessageMeta(sessionId, assistantMsgId, {
            model: event.model || "",
            tokens_in: event.tokens_in || 0,
            tokens_out: event.tokens_out || 0,
            duration_s: event.duration_s || 0,
          }, historyTopic);
          window.dispatchEvent(
            new CustomEvent("crew:message_meta", {
              detail: {
                model: event.model || "",
                tokens_in: event.tokens_in || 0,
                tokens_out: event.tokens_out || 0,
                session_cost: event.session_cost,
                duration_s: event.duration_s || 0,
                sessionId,
                topic: normalizedHistoryTopic,
                messageId: assistantMsgId,
              },
            }),
          );
        }

        // Detect queue/adaptive mode changes from command responses
        detectModeUpdate(finalText, sessionId);

        // Clear thinking state
        window.dispatchEvent(
          new CustomEvent("crew:thinking", {
            detail: {
              thinking: false,
              iteration: 0,
              sessionId,
              topic: normalizedHistoryTopic,
            },
          }),
        );

        const bgTasks = Array.isArray(event.bg_tasks) ? event.bg_tasks : [];
        let hasValidBgTask = false;
        for (const task of bgTasks) {
          const anchorId = MessageStore.bindBackgroundTask(sessionId, task, historyTopic);
          if (!anchorId) continue;
          hasValidBgTask = true;
          window.dispatchEvent(
            new CustomEvent("crew:task_status", {
              detail: { task, sessionId, topic: historyTopic },
            }),
          );
        }

        if (hasValidBgTask) {
          window.dispatchEvent(
            new CustomEvent("crew:bg_tasks", {
              detail: { sessionId, topic: historyTopic },
            }),
          );
        }

        onComplete?.();
        break;
      }

      case "error": {
        const errMsg = event.message || "Agent error";
        pendingStreamError.current = errMsg;
        for (const toolCall of toolCalls.values()) {
          if (toolCall.status === "running") {
            toolCall.status = "error";
          }
        }
        if (toolCalls.size > 0) {
          MessageStore.updateMessage(sessionId, assistantMsgId, {
            toolCalls: Array.from(toolCalls.values()),
          }, historyTopic);
        }
        window.dispatchEvent(
          new CustomEvent("crew:thinking", {
            detail: {
              thinking: false,
              iteration: 0,
              sessionId,
              topic: normalizedHistoryTopic,
            },
          }),
        );
        break;
      }

      case "stream_end":
        break;
    }
  };

  // Subscribe with replay — events that arrived before subscription are replayed.
  const unsub = StreamManager.subscribe(sessionId, handleEvent, historyTopic);
  if (unsub) {
    setupCleanup(
      sessionId,
      assistantMsgId,
      unsub,
      rawText,
      historyTopic,
      onComplete,
      abortController,
      clientMessageId,
      sentAt,
      pendingStreamError,
    );
  }
}

/** Unsubscribe when stream ends and poll if no content arrived. */
function setupCleanup(
  sessionId: string,
  assistantMsgId: string,
  _unsub: () => void,
  _rawText: string,
  historyTopic?: string,
  _onComplete?: () => void,
  _abortController?: AbortController,
  clientMessageId?: string,
  sentAt?: number,
  pendingStreamError?: { current: string | null },
): void {
  // The subscriber is automatically cleaned up when the stream ends
  // (StreamManager clears subscribers). We also listen for stream_state
  // to handle the case where the stream ends without a done event.
  const normalizedHistoryTopic = historyTopic?.trim() || undefined;
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const detailTopic =
      typeof detail?.topic === "string" && detail.topic.trim()
        ? detail.topic.trim()
        : undefined;
    if (
      detail?.sessionId === sessionId &&
      detailTopic === normalizedHistoryTopic &&
      !detail.active
    ) {
      window.removeEventListener("crew:stream_state", handler);
      _unsub();

      // If the message is still streaming (no done event received), check if we got content
      const msgs = MessageStore.getMessages(sessionId, historyTopic);
      const assistantMsg = msgs.find((m) => m.id === assistantMsgId);
      if (assistantMsg && assistantMsg.status === "streaming") {
        if (pendingStreamError?.current) {
          pollForResponse(
            sessionId,
            assistantMsgId,
            clientMessageId,
            sentAt,
            historyTopic,
            _abortController?.signal,
            {
              maxAttempts: 12,
              intervalMs: 1000,
              errorMessage: pendingStreamError.current,
            },
          ).then(() => _onComplete?.());
        } else if (assistantMsg.text) {
          MessageStore.updateMessage(sessionId, assistantMsgId, {
            status: "complete",
          }, historyTopic);
          _onComplete?.();
        } else {
          // No content — poll for response
          pollForResponse(
            sessionId,
            assistantMsgId,
            clientMessageId,
            sentAt,
            historyTopic,
            _abortController?.signal,
          ).then(() => _onComplete?.());
        }
      }
    }
  };
  window.addEventListener("crew:stream_state", handler);
}

/** Poll for a response if the stream ended without content. */
async function pollForResponse(
  sessionId: string,
  assistantMsgId: string,
  clientMessageId?: string,
  sentAt?: number,
  historyTopic?: string,
  abortSignal?: AbortSignal,
  options?: {
    maxAttempts?: number;
    intervalMs?: number;
    errorMessage?: string;
  },
): Promise<boolean> {
  const maxAttempts = options?.maxAttempts ?? 180;
  const intervalMs = options?.intervalMs ?? 5000;
  for (let i = 0; i < maxAttempts; i++) {
    if (abortSignal?.aborted) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const msgs = await fetchSessionMessages(
        sessionId,
        50,
        0,
        undefined,
        historyTopic,
      );

      const matchedAssistant = [...msgs].reverse().find((message) => {
        if (message.role !== "assistant") return false;
        if (!message.content || message.content.trim().length <= 20)
          return false;
        if (clientMessageId) {
          return message.response_to_client_message_id === clientMessageId;
        }

        if (!sentAt) return false;
        const messageTime = Date.parse(message.timestamp);
        if (Number.isNaN(messageTime)) return false;
        return messageTime >= sentAt - 2_000;
      });

      if (matchedAssistant) {
        const merged = MessageStore.mergeHistoryMessageIntoMessage(
          sessionId,
          assistantMsgId,
          matchedAssistant,
          historyTopic,
        );
        if (!merged) {
          MessageStore.appendHistoryMessages(sessionId, [matchedAssistant], historyTopic);
          MessageStore.updateMessage(sessionId, assistantMsgId, {
            text: matchedAssistant.content,
            status: "complete",
          }, historyTopic);
        }
        return true;
      }
    } catch {
      // keep polling
    }
  }
  if (!options?.errorMessage) {
    MessageStore.updateMessage(sessionId, assistantMsgId, {
      text: "No response received.",
      status: "error",
    }, historyTopic);
    return false;
  }

  MessageStore.updateMessage(sessionId, assistantMsgId, {
    text: `Error: ${options.errorMessage}`,
    status: "error",
  }, historyTopic);
  return false;
}
