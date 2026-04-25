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
import {
  applyAppendFileArtifact,
  applyFinalizeAssistant,
  applyRegisterBackgroundAnchor,
  applyReplaceAssistantText,
  applyStreamError,
  applyTaskStatus,
  applyUpdateToolCalls,
  isEventInScope,
} from "@/store/message-store-actions";
import { displayFilenameFromPath } from "@/lib/utils";
import { getMessages as fetchSessionMessages } from "@/api/sessions";
import { dispatchCrewFileEvent } from "./file-events";
import { recordRuntimeCounter } from "./observability";

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
    if (!isEventInScope(event, { sessionId, topic: normalizedHistoryTopic })) {
      recordRuntimeCounter("octos_session_mismatch_total", {
        surface: "sse_bridge",
      });
      return;
    }

    switch (event.type) {
      case "token":
        rawText += event.text;
        applyReplaceAssistantText({
          type: "replace_assistant_text",
          sessionId,
          messageId: assistantMsgId,
          topic: historyTopic,
          text: clean(rawText),
        });
        break;

      case "replace":
        rawText = event.text;
        applyReplaceAssistantText({
          type: "replace_assistant_text",
          sessionId,
          messageId: assistantMsgId,
          topic: historyTopic,
          text: clean(rawText),
        });
        break;

      case "tool_start": {
        const key = `tc_${++toolCallCounter}`;
        const tcId =
          event.tool_call_id ||
          event.tool_id ||
          `tc_${event.tool}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        toolCalls.set(key, { id: tcId, name: event.tool, status: "running" });
        activeToolByName.set(event.tool, key);
        applyUpdateToolCalls({
          type: "update_tool_calls",
          sessionId,
          messageId: assistantMsgId,
          topic: historyTopic,
          toolCalls: Array.from(toolCalls.values()),
        });
        break;
      }

      case "tool_end": {
        const key = activeToolByName.get(event.tool);
        const tc = key ? toolCalls.get(key) : undefined;
        if (tc) tc.status = event.success ? "complete" : "error";
        applyUpdateToolCalls({
          type: "update_tool_calls",
          sessionId,
          messageId: assistantMsgId,
          topic: historyTopic,
          toolCalls: Array.from(toolCalls.values()),
        });
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
          applyAppendFileArtifact({
            type: "append_file_artifact",
            sessionId,
            topic: historyTopic,
            file,
            toolCallId: event.tool_call_id,
          });

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
        // Extract server_seq / updated_at from either the event envelope
        // (preferred) or the embedded task snapshot (fallback). Without
        // these, the task-store's conflict resolution cannot tiebreak a
        // stale task-watcher poll against this authoritative SSE update.
        const serverSeq =
          typeof event.server_seq === "number"
            ? event.server_seq
            : typeof event.task.server_seq === "number"
              ? event.task.server_seq
              : undefined;
        const updatedAt =
          typeof event.updated_at === "string"
            ? event.updated_at
            : typeof event.task.updated_at === "string"
              ? event.task.updated_at
              : undefined;

        applyTaskStatus({
          type: "task_status",
          sessionId,
          topic: historyTopic,
          task: event.task,
          serverSeq,
          updatedAt,
        });
        // Re-dispatch on the window so the runtime-provider's task-watcher
        // side effects fire (setServerTaskActive + watchSession). The
        // runtime-provider listener no longer re-merges — the merge above
        // is the single source of truth for task-store writes on SSE.
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: {
              task: event.task,
              sessionId,
              topic: historyTopic,
              serverSeq,
              updatedAt,
              _alreadyMerged: true,
            },
          }),
        );
        break;
      }

      case "session_result": {
        if (event.message) {
          // User-message session_result (this fix): when the server
          // persists the user turn it broadcasts a session_result with
          // role="user" + the client-supplied `client_message_id`. We
          // locate the optimistic user bubble by that id and stamp the
          // authoritative `historySeq` onto it so subsequent seq'd
          // messages don't bump it past MAX_SAFE_INTEGER.
          //
          // Tolerate legacy/missing variants: when no matching bubble
          // exists, fall back to appending the message into history so
          // server-side sessions that pre-date this event shape still
          // render correctly.
          if (
            event.message.role === "user" &&
            typeof event.message.seq === "number" &&
            typeof event.message.client_message_id === "string"
          ) {
            const updated = MessageStore.setMessageHistorySeqByClientMessageId(
              sessionId,
              event.message.client_message_id,
              event.message.seq,
              historyTopic,
            );
            if (!updated) {
              // No optimistic bubble matched (resumed session, restart,
              // or message arrived before the bubble was created) — fall
              // back to a normal history append.
              MessageStore.appendHistoryMessages(sessionId, [event.message], historyTopic);
            }
            break;
          }

          // FA-12f: under `/queue speculative`, the server emits
          // overflow session_result events onto the PRIMARY turn's SSE
          // stream (ApiChannel broadcasts to `pending[chat_id]` in
          // addition to `watchers`). Blindly merging every
          // session_result into this bubble's `assistantMsgId` clobbers
          // the primary bubble (ALPHA) with the overflow reply (BRAVO)
          // and then the collapse pass removes BRAVO's own streaming
          // bubble as a "duplicate" — so BRAVO never renders.
          //
          // Route by `response_to_client_message_id` correlation:
          //   - match this bubble  → merge in place (fast path; keeps
          //     file artifacts, tool calls, meta attached to the bubble)
          //   - different bubble  → go through appendHistoryMessages so
          //     findOptimisticMatchIndex correlates against the right
          //     sibling bubble
          //   - no correlation    → legacy behaviour (in-place merge)
          const incomingCmid = event.message.response_to_client_message_id;
          const isForThisBubble =
            !incomingCmid || !clientMessageId || incomingCmid === clientMessageId;

          const previousSeq = MessageStore.getMaxHistorySeq(sessionId, historyTopic);
          if (isForThisBubble) {
            const merged = MessageStore.mergeHistoryMessageIntoMessage(
              sessionId,
              assistantMsgId,
              event.message,
              historyTopic,
            );
            if (!merged) {
              MessageStore.appendHistoryMessages(sessionId, [event.message], historyTopic);
            }
          } else {
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
        const meta = event.model || event.tokens_in || event.tokens_out
          ? {
              model: event.model || "",
              tokens_in: event.tokens_in || 0,
              tokens_out: event.tokens_out || 0,
              duration_s: event.duration_s || 0,
            }
          : undefined;
        // M8.10-A: thread the server-committed seq onto the live bubble so
        // it sorts in chronological order alongside seq'd history. Old
        // server builds may omit `committed_seq`; in that case the bubble
        // keeps no historySeq and falls back to timestamp-only ordering.
        const historySeq =
          typeof event.committed_seq === "number" ? event.committed_seq : undefined;
        applyFinalizeAssistant({
          type: "finalize_assistant",
          sessionId,
          messageId: assistantMsgId,
          topic: historyTopic,
          text: finalText,
          meta,
          historySeq,
        });

        if (meta) {
          window.dispatchEvent(
            new CustomEvent("crew:message_meta", {
              detail: {
                ...meta,
                session_cost: event.session_cost,
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

        // Background task and deferred-file synchronization is owned by the
        // session runtime's incremental sync loop (appendHistoryMessages).
        // We no longer call replaceHistory here — it races with the sync loop
        // and can wipe optimistic messages or create duplicates.
        if (event.has_bg_tasks) {
          applyRegisterBackgroundAnchor({
            type: "register_background_anchor",
            sessionId,
            topic: historyTopic,
            messageId: assistantMsgId,
            toolNames: Array.from(toolCalls.values()).map((toolCall) => toolCall.name),
          });
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
  const subscription = StreamManager.subscribe(sessionId, handleEvent, historyTopic);
  if (subscription) {
    setupCleanup(
      sessionId,
      assistantMsgId,
      subscription.unsub,
      rawText,
      historyTopic,
      onComplete,
      abortController,
      clientMessageId,
      sentAt,
      pendingStreamError,
      subscription.streamId,
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
  streamId?: number,
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
    // When two prompts fire before either finishes, both subscribers share
    // the same (sessionId, topic) but are attached to different streams.
    // The event must match THIS stream's id — otherwise a fast sibling
    // stream finishing first would trip this handler, unsubscribe from our
    // still-running stream, and strand the assistant bubble on the slow
    // poll-recovery path (see concurrent-deep-research-ordering.spec.ts).
    if (
      detail?.sessionId === sessionId &&
      detailTopic === normalizedHistoryTopic &&
      !detail.active &&
      (streamId === undefined ||
        typeof detail?.streamId !== "number" ||
        detail.streamId === streamId)
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
          applyFinalizeAssistant({
            type: "finalize_assistant",
            sessionId,
            messageId: assistantMsgId,
            topic: historyTopic,
            text: assistantMsg.text,
          });
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
        if (!message.content) return false;
        if (clientMessageId) {
          // Authoritative cmid correlation — trust server-side routing even
          // when the reply text is short (e.g. a shell echo of <= 20 chars
          // under speculative queue mode). Previously the content-length
          // guard here rejected legitimate short BRAVO replies and the
          // overflow bubble stayed empty (FA-12f web-side fallback).
          return message.response_to_client_message_id === clientMessageId;
        }
        // Time-based fallback — keep the length guard to avoid matching
        // short server-side system replies when cmid is not available.
        if (message.content.trim().length <= 20) return false;
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
          applyFinalizeAssistant({
            type: "finalize_assistant",
            sessionId,
            messageId: assistantMsgId,
            topic: historyTopic,
            text: matchedAssistant.content,
          });
        }
        return true;
      }
    } catch {
      // keep polling
    }
  }
  // Timeout reached. When the caller supplied a clientMessageId, the reply
  // MAY still arrive later via the session-event-stream watcher: speculative
  // queue mode can park a turn behind an overflow/primary cycle that
  // exceeds our 15-min poll window. In that case, do NOT overwrite the
  // bubble with "No response received." — leave it in streaming state so
  // findOptimisticMatchIndex (matching by responseToClientMessageId) can
  // merge the eventual authoritative session_result into it. The caller's
  // onComplete still fires so abort/cleanup proceeds.
  if (clientMessageId && !options?.errorMessage) {
    return false;
  }

  if (!options?.errorMessage) {
    applyStreamError({
      type: "stream_error",
      sessionId,
      messageId: assistantMsgId,
      topic: historyTopic,
      errorMessage: "No response received.",
      raw: true,
    });
    return false;
  }

  applyStreamError({
    type: "stream_error",
    sessionId,
    messageId: assistantMsgId,
    topic: historyTopic,
    errorMessage: options.errorMessage,
  });
  return false;
}
