/**
 * WebSocket-based ChatModelAdapter — replaces the SSE generator adapter.
 *
 * Maintains a single persistent WebSocket per session. On run(), sends a
 * JSON message over WS and translates incoming events into the same
 * ChatModelRunResult yields that the SSE adapter produced.
 *
 * Falls back to the original SSE adapter if the WS connection fails.
 */

import type {
  ChatModelAdapter,
  ChatModelRunResult,
} from "@assistant-ui/react";
import { getToken } from "@/api/client";
import { getMessages as fetchSessionMessages } from "@/api/sessions";
import { API_BASE } from "@/lib/constants";
import { displayFilenameFromPath } from "@/lib/utils";
import { getSettings } from "@/hooks/use-settings";
import { createOctosAdapter } from "./octos-adapter";
import { dispatchCrewFileEvent } from "./file-events";
import * as MessageStore from "@/store/message-store";


// ---------------------------------------------------------------------------
// Helpers shared with octos-adapter.ts
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

// ---------------------------------------------------------------------------
// WebSocket connection management
// ---------------------------------------------------------------------------

interface WsConnection {
  ws: WebSocket;
  sessionId: string;
  ready: Promise<void>;
  /** Whether the WS opened successfully at least once. */
  opened: boolean;
}

const connections = new Map<string, WsConnection>();

/** How long to wait for WS open before falling back. */
const WS_OPEN_TIMEOUT_MS = 5000;

/** Max reconnection attempts before permanent fallback. */
const MAX_RECONNECT = 3;

function getWsUrl(): string {
  const base = API_BASE || window.location.origin;
  const proto = base.startsWith("https") ? "wss" : "ws";
  const host = base.replace(/^https?:\/\//, "");
  return `${proto}://${host}/api/ws`;
}

function connectWs(sessionId: string): WsConnection {
  const existing = connections.get(sessionId);
  if (existing && existing.ws.readyState <= WebSocket.OPEN) {
    return existing;
  }

  const token = getToken();
  const url = new URL(getWsUrl());
  // NOTE: Passing auth token in the query string is a security trade-off
  // (visible in server logs, browser history, etc.). WebSocket does not support
  // custom headers from browser JS; the Sec-WebSocket-Protocol approach requires
  // server-side changes. Keeping query string auth for server compatibility.
  if (token) url.searchParams.set("token", token);
  url.searchParams.set("session", sessionId);

  const ws = new WebSocket(url.toString());

  let resolveReady: () => void;
  let rejectReady: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const conn: WsConnection = { ws, sessionId, ready, opened: false };

  const timeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.close();
      rejectReady(new Error("WebSocket open timeout"));
    }
  }, WS_OPEN_TIMEOUT_MS);

  ws.addEventListener("open", () => {
    clearTimeout(timeout);
    conn.opened = true;
    resolveReady();
  });

  ws.addEventListener("error", () => {
    clearTimeout(timeout);
    if (!conn.opened) {
      rejectReady(new Error("WebSocket connection failed"));
    }
  });

  ws.addEventListener("close", () => {
    clearTimeout(timeout);
    connections.delete(sessionId);
    if (!conn.opened) {
      rejectReady(new Error("WebSocket closed before open"));
    }
  });

  connections.set(sessionId, conn);
  return conn;
}

/** Close and remove a WS connection for a session. */
export function destroyWs(sessionId: string): void {
  const conn = connections.get(sessionId);
  if (conn) {
    conn.ws.close();
    connections.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export function createWsAdapter(
  getSessionId: () => string,
  onMessageComplete?: () => void,
  getPendingMedia?: () => string[],
  onMessageSent?: (firstMessage: string) => void,
  getHistoryTopic?: () => string | undefined,
): ChatModelAdapter {
  // Keep the SSE adapter as a fallback
  const sseAdapter = createOctosAdapter(
    getSessionId,
    onMessageComplete,
    getPendingMedia,
    onMessageSent,
  );

  let reconnectCount = 0;
  /** Once set, all future runs use SSE. */
  let permanentFallback = false;

  return {
    async *run(options) {
      const sessionId = getSessionId();
      const historyTopic = getHistoryTopic?.();
      const lastMsg = options.messages[options.messages.length - 1];
      const userText = extractText(lastMsg);
      const media = getPendingMedia?.() ?? [];

      // If we've permanently fallen back, use SSE directly
      if (permanentFallback) {
        yield* sseAdapter.run(options) as AsyncGenerator<ChatModelRunResult>;
        return;
      }

      // Try WebSocket
      let conn: WsConnection;
      try {
        conn = connectWs(sessionId);
        await conn.ready;
        reconnectCount = 0; // reset on success
      } catch {
        reconnectCount++;
        if (reconnectCount >= MAX_RECONNECT) {
          permanentFallback = true;
          console.warn(
            "[ws-adapter] WebSocket failed %d times, falling back to SSE permanently",
            reconnectCount,
          );
        } else {
          console.warn(
            "[ws-adapter] WebSocket connect failed, falling back to SSE for this message",
          );
        }
        yield* sseAdapter.run(options) as AsyncGenerator<ChatModelRunResult>;
        return;
      }

      // Mark session as active in sidebar
      onMessageSent?.(userText);

      // Dispatch stream_state so other UI bits know we're active
      window.dispatchEvent(
        new CustomEvent("crew:stream_state", {
          detail: { sessionId, active: true },
        }),
      );

      // Add user message to store
      MessageStore.addMessage(sessionId, {
        role: "user",
        text: userText,
        files: [],
        toolCalls: [],
        status: "complete",
      }, historyTopic);

      // Send via WebSocket
      const settings = getSettings();
      const payload: Record<string, unknown> = {
        type: "send",
        content: userText,
        session: sessionId,
      };
      if (media.length > 0) payload.media = media;
      if (settings.searchEngine) payload.search_engine = settings.searchEngine;

      conn.ws.send(JSON.stringify(payload));

      // Create assistant message in store for streaming
      const assistantMsgId = MessageStore.addMessage(sessionId, {
        role: "assistant",
        text: "",
        files: [],
        toolCalls: [],
        status: "streaming",
      }, historyTopic);

      // Consume WS events via an async queue
      let text = "";
      let toolCallCounter = 0;
      const toolCalls = new Map<
        string,
        { toolCallId: string; toolName: string; status: string }
      >();
      /** Maps tool name to the most recent toolCall key (for tool_end matching). */
      const activeToolByName = new Map<string, string>();
      let done = false;

      type WsEvent = Record<string, unknown> & { type: string };
      const queue: WsEvent[] = [];
      let resolve: (() => void) | null = null;

      const onMessage = (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data as string) as WsEvent;
          queue.push(data);
          if (resolve) {
            resolve();
            resolve = null;
          }
        } catch {
          // ignore non-JSON frames
        }
      };

      const onClose = () => {
        // Push a synthetic close event so the loop can exit
        queue.push({ type: "_ws_close" });
        if (resolve) {
          resolve();
          resolve = null;
        }
      };

      const onError = () => {
        queue.push({ type: "_ws_error" });
        if (resolve) {
          resolve();
          resolve = null;
        }
      };

      conn.ws.addEventListener("message", onMessage);
      conn.ws.addEventListener("close", onClose);
      conn.ws.addEventListener("error", onError);

      try {
        while (!done) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              resolve = r;
              options.abortSignal.addEventListener("abort", () => r(), {
                once: true,
              });
            });
          }

          if (options.abortSignal.aborted) break;

          while (queue.length > 0) {
            const event = queue.shift()!;

            switch (event.type) {
              case "token":
                text += event.text as string;
                MessageStore.appendText(
                  sessionId,
                  assistantMsgId,
                  event.text as string,
                  historyTopic,
                );
                yield buildResult(
                  stripToolProgress(stripThink(text)),
                  toolCalls,
                );
                break;

              case "replace":
                text = event.text as string;
                MessageStore.updateMessage(sessionId, assistantMsgId, {
                  text,
                }, historyTopic);
                yield buildResult(
                  stripToolProgress(stripThink(text)),
                  toolCalls,
                );
                break;

              case "tool_start": {
                const toolName = event.tool as string;
                const key = `tc_${++toolCallCounter}`;
                const tcId = `tc_${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                toolCalls.set(key, {
                  toolCallId: tcId,
                  toolName,
                  status: "running",
                });
                activeToolByName.set(toolName, key);
                MessageStore.updateMessage(sessionId, assistantMsgId, {
                  toolCalls: Array.from(toolCalls.values()).map((tc) => ({
                    id: tc.toolCallId,
                    name: tc.toolName,
                    status: tc.status as "running" | "complete" | "error",
                  })),
                }, historyTopic);
                yield buildResult(text, toolCalls);
                break;
              }

              case "tool_end": {
                const key = activeToolByName.get(event.tool as string);
                const tc = key ? toolCalls.get(key) : undefined;
                if (tc)
                  tc.status = (event.success as boolean)
                    ? "complete"
                    : "error";
                MessageStore.updateMessage(sessionId, assistantMsgId, {
                  toolCalls: Array.from(toolCalls.values()).map((t) => ({
                    id: t.toolCallId,
                    name: t.toolName,
                    status: t.status as "running" | "complete" | "error",
                  })),
                }, historyTopic);
                yield buildResult(text, toolCalls);
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
                    },
                  }),
                );
                break;

              case "cost_update":
                window.dispatchEvent(
                  new CustomEvent("crew:cost", {
                    detail: { ...event, sessionId },
                  }),
                );
                break;

              case "file": {
                const filePath = event.path as string | undefined;
                const filename = event.filename as string | undefined;
                const caption = (event.caption as string) || "";
                const toolCallId = event.tool_call_id as string | undefined;

                if (filePath && filename) {
                  // Append file to the correct message (by tool_call_id or current assistant msg)
                  let targetMsgId = assistantMsgId;
                  if (toolCallId) {
                    // Find the message that has a tool call with this id
                    const msgs = MessageStore.getMessages(sessionId, historyTopic);
                    const match = msgs.find((m) =>
                      m.toolCalls.some((tc) => tc.id === toolCallId),
                    );
                    if (match) targetMsgId = match.id;
                  }

                  MessageStore.appendFile(sessionId, targetMsgId, {
                    filename,
                    path: filePath,
                    caption,
                  }, historyTopic);

                  dispatchCrewFileEvent({
                    sessionId,
                    topic: historyTopic,
                    path: filePath,
                    filename,
                    caption,
                  });
                }
                break;
              }

              case "session_result": {
                const message = event.message as
                  | {
                      media?: string[];
                      content: string;
                      role: "assistant" | "user" | "system" | "tool";
                      seq?: number;
                      timestamp: string;
                    }
                  | undefined;
                if (message) {
                  const previousSeq = MessageStore.getMaxHistorySeq(sessionId, historyTopic);
                  const merged = MessageStore.mergeHistoryMessageIntoMessage(
                    sessionId,
                    assistantMsgId,
                    message,
                    historyTopic,
                  );
                  if (!merged) {
                    MessageStore.appendHistoryMessages(sessionId, [message], historyTopic);
                  }
                  const observedSeq =
                    typeof message.seq === "number"
                      ? message.seq
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
                  for (const filePath of message.media ?? []) {
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
                const doneContent = event.content as string | undefined;
                if (doneContent) {
                  text = stripToolProgress(stripThink(doneContent));
                }
                MessageStore.updateMessage(sessionId, assistantMsgId, {
                  text,
                  status: "complete",
                }, historyTopic);

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
              }

              case "error": {
                const errMsg =
                  (event.message as string) || "Agent error";
                text = `⚠️ Error: ${errMsg}`;
                MessageStore.updateMessage(sessionId, assistantMsgId, {
                  text,
                  status: "error",
                }, historyTopic);
                yield buildResult(text, toolCalls);
                done = true;
                break;
              }

              case "_ws_close":
              case "_ws_error":
                if (!done) {
                  // WS dropped mid-stream — try to recover the response
                  if (text) {
                    MessageStore.updateMessage(sessionId, assistantMsgId, {
                      status: "complete",
                    }, historyTopic);
                  } else {
                    MessageStore.updateMessage(sessionId, assistantMsgId, {
                      text: "⚠️ Connection lost",
                      status: "error",
                    }, historyTopic);
                  }
                  done = true;
                }
                break;
            }
          }
        }
      } finally {
        conn.ws.removeEventListener("message", onMessage);
        conn.ws.removeEventListener("close", onClose);
        conn.ws.removeEventListener("error", onError);
      }

      // If stream ended without content, poll for response (same as SSE adapter)
      if (!text) {
        for (let poll = 0; poll < 180; poll++) {
          if (options.abortSignal.aborted) break;
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const freshToken = getToken();
            const pollResp = await fetch(
              `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/messages?${new URLSearchParams({
                limit: "3",
                ...(historyTopic?.trim() ? { topic: historyTopic.trim() } : {}),
              }).toString()}`,
              {
                headers: freshToken ? { Authorization: `Bearer ${freshToken}` } : {},
              },
            );
            if (pollResp.ok) {
              const pollMsgs = (await pollResp.json()) as {
                role: string;
                content: string;
              }[];
              const lastAssistant = [...pollMsgs]
                .reverse()
                .find(
                  (m) => m.role === "assistant" && m.content.length > 20,
                );
              if (lastAssistant) {
                text = lastAssistant.content;
                MessageStore.updateMessage(sessionId, assistantMsgId, {
                  text,
                  status: "complete",
                }, historyTopic);
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

      window.dispatchEvent(
        new CustomEvent("crew:stream_state", {
          detail: { sessionId, active: false },
        }),
      );

      onMessageComplete?.();
    },
  };
}
