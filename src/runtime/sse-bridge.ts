/**
 * SSE-to-store bridge.
 *
 * Translates each SSE event into a thread-store mutation. Every event the
 * server sends carries `thread_id` (added in M8.10 PR #2) so the bridge
 * routes by thread, not by recency or by a single "current" assistant
 * bubble. After M8.10 PR #5 there's no flat-list fallback and no
 * legacy `session_result` user-message merge — `thread_id` is THE routing
 * key for every wire event.
 *
 * File events that arrive after `done` still update the message via the
 * thread store's tool-call / background-anchor indices.
 */

import * as StreamManager from "./stream-manager";
import * as ThreadStore from "@/store/thread-store";
import { displayFilenameFromPath } from "@/lib/utils";
import { getMessages as fetchSessionMessages } from "@/api/sessions";
import { dispatchCrewFileEvent } from "./file-events";
import { recordRuntimeCounter } from "./observability";
import { eventSessionId, eventTopic } from "./event-scope";

// ---------------------------------------------------------------------------
// Helpers
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
 * Send a user message and wire the resulting SSE stream into the thread store.
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

  // 1. Open a new thread rooted at this user message — also creates a
  //    pending streaming assistant bubble that the SSE handlers will fill.
  ThreadStore.addUserMessage(sessionId, {
    text,
    clientMessageId,
    files: localFiles,
    topic: historyTopic,
  });

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

  // 3. Subscribe to events and route into the thread store.
  bindStreamToAssistant({
    sessionId,
    clientMessageId,
    onComplete,
    abortController,
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
  const threadId = ThreadStore.ensureStreamingAssistantThread(
    sessionId,
    "Resuming ongoing work...",
    historyTopic,
  );

  bindStreamToAssistant({
    sessionId,
    clientMessageId: threadId,
    onComplete,
    abortController,
    sentAt: Date.now(),
    historyTopic,
  });
}

function bindStreamToAssistant({
  sessionId,
  clientMessageId,
  onComplete,
  abortController,
  sentAt,
  historyTopic,
}: {
  sessionId: string;
  clientMessageId: string;
  onComplete?: () => void;
  abortController: AbortController;
  sentAt: number;
  historyTopic?: string;
}): void {
  let rawText = "";
  let toolCallCounter = 0;
  const pendingStreamError = { current: null as string | null };
  const toolCallNamesById = new Map<string, string>();
  /** Maps tool name to the most recent toolCall id (for tool_end matching). */
  const activeToolByName = new Map<string, string>();
  /** Maps server-side tool_call_id (which may be either tool_call_id or
   *  tool_id in the wire event) to our canonical local id. */
  const keyByServerId = new Map<string, string>();
  const normalizedHistoryTopic = historyTopic?.trim() || undefined;
  /** Cache of every tool name we've seen this stream — fed into
   *  registerBackgroundAnchor so post-`done` files route correctly. */
  const seenToolNames: string[] = [];

  /** Resolve the routing thread_id for an SSE event. Falls back to the
   *  bound user cmid (rooted by `sendMessage` / `resumeSessionStream`),
   *  then to the cross-thread synthesizer in the store. */
  const resolveThreadId = (
    payloadThreadId: string | undefined,
  ): string | null => {
    if (payloadThreadId) return payloadThreadId;
    if (clientMessageId) return clientMessageId;
    return ThreadStore.resolveEventThreadId(
      sessionId,
      normalizedHistoryTopic,
      undefined,
    );
  };

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
      case "token": {
        rawText += event.text;
        const tid = resolveThreadId(event.thread_id);
        if (tid) ThreadStore.replaceAssistantText(tid, clean(rawText));
        break;
      }

      case "replace": {
        rawText = event.text;
        const tid = resolveThreadId(event.thread_id);
        if (tid) ThreadStore.replaceAssistantText(tid, clean(rawText));
        break;
      }

      case "tool_start": {
        toolCallCounter += 1;
        // Prefer the server-issued tool_call_id (then the legacy tool_id) so
        // tool_progress and tool_end can route by id; synthesize an id only
        // when the backend omits both.
        const tcId =
          event.tool_call_id ||
          event.tool_id ||
          `tc_${event.tool}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        toolCallNamesById.set(tcId, event.tool);
        activeToolByName.set(event.tool, tcId);
        if (event.tool_call_id) keyByServerId.set(event.tool_call_id, tcId);
        if (event.tool_id) keyByServerId.set(event.tool_id, tcId);
        seenToolNames.push(event.tool);
        const tid = resolveThreadId(event.thread_id);
        if (tid) ThreadStore.addToolCall(tid, tcId, event.tool);
        break;
      }

      case "tool_end": {
        const localId =
          (event.tool_call_id && keyByServerId.get(event.tool_call_id)) ||
          (event.tool_id && keyByServerId.get(event.tool_id)) ||
          activeToolByName.get(event.tool);
        if (!localId) break;
        const tid = resolveThreadId(event.thread_id);
        if (tid) {
          ThreadStore.setToolCallStatus(
            tid,
            localId,
            event.success ? "complete" : "error",
          );
        }
        break;
      }

      case "tool_progress": {
        const localId =
          (event.tool_call_id && keyByServerId.get(event.tool_call_id)) ||
          (event.tool_id && keyByServerId.get(event.tool_id)) ||
          activeToolByName.get(event.tool);
        const tid = resolveThreadId(event.thread_id);
        const targetTcId = localId ?? event.tool_call_id ?? event.tool_id;
        if (tid && targetTcId) {
          ThreadStore.appendToolProgress(tid, targetTcId, event.message);
        }
        // Keep the legacy global indicator working for components that
        // listen to `crew:tool_progress` (project files, site preview).
        window.dispatchEvent(
          new CustomEvent("crew:tool_progress", {
            detail: {
              tool: event.tool,
              message: event.message,
              sessionId,
              topic: historyTopic,
              tool_call_id: event.tool_call_id,
            },
          }),
        );
        break;
      }

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

          // Routing precedence:
          //   1. event.thread_id → bind to the named thread
          //   2. tool_call_id → bind to the tool-call's host message
          //   3. background anchor → most recent thread that registered one
          const tid = resolveThreadId(event.thread_id);
          let attached = false;
          if (tid) {
            attached = ThreadStore.appendFileToThread(
              sessionId,
              tid,
              file,
              historyTopic,
            );
          }
          if (!attached) {
            attached = ThreadStore.appendFileByToolCallId(
              sessionId,
              event.tool_call_id,
              file,
              historyTopic,
            );
          }
          if (!attached) {
            ThreadStore.appendFileToBackgroundAnchor(
              sessionId,
              file,
              historyTopic,
            );
          }

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
        ThreadStore.bindBackgroundTask(sessionId, event.task, historyTopic);
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { task: event.task, sessionId, topic: historyTopic },
          }),
        );
        break;
      }

      case "session_result": {
        // Delivery surface for assistant-side late-binding (durable
        // broadcast from `broadcast_session_event` for overflow assistant
        // replies, file-delivery commits, and background notifications).
        // After M8.10 PR #5 the user-message session_result emissions are
        // gone — every event the bridge sees here is for an assistant or
        // tool message. Run it through the standard history-merge path so
        // it lands in the right thread by `response_to_client_message_id`.
        if (event.message) {
          const previousSeq = ThreadStore.getMaxHistorySeq(sessionId, historyTopic);
          ThreadStore.appendHistoryMessages(
            sessionId,
            [event.message],
            historyTopic,
          );
          const observedSeq =
            typeof event.message.seq === "number"
              ? event.message.seq
              : ThreadStore.getMaxHistorySeq(sessionId, historyTopic);
          if (observedSeq > previousSeq + 1) {
            void fetchSessionMessages(
              sessionId,
              500,
              0,
              previousSeq >= 0 ? previousSeq : undefined,
              historyTopic,
            )
              .then((messages) => {
                ThreadStore.appendHistoryMessages(sessionId, messages, historyTopic);
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
        const tid = resolveThreadId(event.thread_id);
        if (tid) {
          // Replace text first so the finalized message holds the cleaned
          // final text rather than the raw token stream.
          ThreadStore.replaceAssistantText(tid, finalText);
          ThreadStore.finalizeAssistant(tid, {
            committedSeq: event.committed_seq,
            meta:
              event.model || event.tokens_in || event.tokens_out
                ? {
                    model: event.model || "",
                    tokens_in: event.tokens_in || 0,
                    tokens_out: event.tokens_out || 0,
                    duration_s: event.duration_s || 0,
                  }
                : undefined,
          });
        }

        if (event.model || event.tokens_in || event.tokens_out) {
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
                threadId: tid ?? clientMessageId,
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
        // session runtime's incremental sync loop. Flag this thread as a
        // background anchor so post-done files route to it.
        if (event.has_bg_tasks && tid) {
          ThreadStore.registerBackgroundAnchor(
            sessionId,
            tid,
            historyTopic,
            seenToolNames,
          );
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
  const unsub = StreamManager.subscribe(sessionId, handleEvent, historyTopic);
  if (unsub) {
    setupCleanup(
      sessionId,
      unsub,
      historyTopic,
      onComplete,
      abortController,
      clientMessageId,
      sentAt,
      pendingStreamError,
      toolCallCounter,
    );
  }
}

/** Unsubscribe when stream ends and poll if no content arrived. */
function setupCleanup(
  sessionId: string,
  _unsub: () => void,
  historyTopic: string | undefined,
  _onComplete: (() => void) | undefined,
  _abortController: AbortController | undefined,
  clientMessageId: string,
  sentAt: number,
  pendingStreamError: { current: string | null },
  toolCallCounter: number,
): void {
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

      // Check if the bound thread still has a streaming assistant. If so,
      // either flag an error or poll for the committed reply via /messages.
      const threads = ThreadStore.getThreads(sessionId, historyTopic);
      const thread = threads.find((t) => t.id === clientMessageId);
      const stillStreaming =
        thread?.pendingAssistant?.status === "streaming";

      if (stillStreaming) {
        if (pendingStreamError.current) {
          pollForResponse(
            sessionId,
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
        } else if (thread?.pendingAssistant?.text) {
          ThreadStore.finalizeAssistant(clientMessageId, { status: "complete" });
          _onComplete?.();
        } else if (toolCallCounter > 0) {
          // Some tool activity — keep the bubble around but mark complete.
          ThreadStore.finalizeAssistant(clientMessageId, { status: "complete" });
          _onComplete?.();
        } else {
          pollForResponse(
            sessionId,
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
  clientMessageId: string,
  sentAt: number | undefined,
  historyTopic: string | undefined,
  abortSignal: AbortSignal | undefined,
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
        ThreadStore.appendHistoryMessages(
          sessionId,
          [matchedAssistant],
          historyTopic,
        );
        return true;
      }
    } catch {
      // keep polling
    }
  }
  if (!options?.errorMessage) {
    ThreadStore.replaceAssistantText(clientMessageId, "No response received.");
    ThreadStore.finalizeAssistant(clientMessageId, { status: "error" });
    return false;
  }

  ThreadStore.replaceAssistantText(
    clientMessageId,
    `Error: ${options.errorMessage}`,
  );
  ThreadStore.finalizeAssistant(clientMessageId, { status: "error" });
  return false;
}
