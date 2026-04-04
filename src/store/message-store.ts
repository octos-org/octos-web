/**
 * Message store — session-scoped message state with React integration.
 *
 * Follows the same useSyncExternalStore pattern as file-store.ts.
 * Messages are keyed by sessionId. History is loaded from the API
 * on first access; streaming updates arrive via the WS adapter.
 */

import { useSyncExternalStore } from "react";
import { getMessages as fetchMessages } from "@/api/sessions";
import { addFile as addToFileStore } from "@/store/file-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallInfo {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
}

export interface MessageFile {
  filename: string;
  path: string;
  caption?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  files: MessageFile[];
  toolCalls: ToolCallInfo[];
  status: "streaming" | "complete" | "error";
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const messagesBySession = new Map<string, Message[]>();
const listeners = new Set<() => void>();
/** Track which sessions have already loaded history from the API. */
const loadedSessions = new Set<string>();
/** Track in-flight history loads to avoid duplicate requests. */
const loadingPromises = new Map<string, Promise<void>>();

let version = 0;
// Snapshot cache keyed by sessionId — invalidated on every notify().
const messageSnapshots = new Map<string, { version: number; data: Message[] }>();

function notify() {
  version++;
  messageSnapshots.clear();
  for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getMessageSnapshot(sessionId: string): Message[] {
  const cached = messageSnapshots.get(sessionId);
  if (cached && cached.version === version) return cached.data;
  const data = messagesBySession.get(sessionId) ?? [];
  messageSnapshots.set(sessionId, { version, data });
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

function getList(sessionId: string): Message[] {
  let list = messagesBySession.get(sessionId);
  if (!list) {
    list = [];
    messagesBySession.set(sessionId, list);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Public API — mutators
// ---------------------------------------------------------------------------

/** Add a new message and return its id. */
export function addMessage(
  sessionId: string,
  msg: Omit<Message, "id" | "timestamp">,
): string {
  const id = nextId();
  const list = getList(sessionId);
  list.push({ ...msg, id, timestamp: Date.now() });
  // Replace the array reference so React picks up the change
  messagesBySession.set(sessionId, [...list]);
  notify();
  return id;
}

/** Update fields on an existing message. */
export function updateMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<Pick<Message, "text" | "status" | "files" | "toolCalls">>,
): void {
  const list = messagesBySession.get(sessionId);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...updates };
  messagesBySession.set(sessionId, [...list]);
  notify();
}

/** Append text to a streaming message. */
export function appendText(
  sessionId: string,
  messageId: string,
  chunk: string,
): void {
  const list = messagesBySession.get(sessionId);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], text: list[idx].text + chunk };
  messagesBySession.set(sessionId, [...list]);
  notify();
}

/** Append a file to a message, de-duplicating by path. */
export function appendFile(
  sessionId: string,
  messageId: string,
  file: MessageFile,
): void {
  const list = messagesBySession.get(sessionId);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  const msg = list[idx];
  if (msg.files.some((f) => f.path === file.path)) return;
  list[idx] = { ...msg, files: [...msg.files, file] };
  messagesBySession.set(sessionId, [...list]);
  notify();
}

/** Get messages for a session (snapshot, not reactive). */
export function getMessages(sessionId: string): Message[] {
  return messagesBySession.get(sessionId) ?? [];
}

/** Clear all messages for a session (e.g. on session delete). */
export function clearMessages(sessionId: string): void {
  messagesBySession.delete(sessionId);
  loadedSessions.delete(sessionId);
  loadingPromises.delete(sessionId);
  notify();
}

// ---------------------------------------------------------------------------
// History loading
// ---------------------------------------------------------------------------

/**
 * Load message history from the API for a session.
 * No-ops if already loaded. Safe to call multiple times concurrently.
 */
export function loadHistory(sessionId: string): Promise<void> {
  if (loadedSessions.has(sessionId)) return Promise.resolve();

  const existing = loadingPromises.get(sessionId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const apiMessages = await fetchMessages(sessionId);
      console.log(`[message-store] loadHistory(${sessionId}): got ${apiMessages.length} messages, roles:`, apiMessages.map(m => m.role));
      // Only populate if the store is still empty for this session
      // (streaming may have started while we were loading)
      if (!messagesBySession.has(sessionId) || messagesBySession.get(sessionId)!.length === 0) {
        const converted: Message[] = [];
        for (const m of apiMessages) {
          if (m.role === "tool") continue; // skip raw tool results
          const role = m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant";
          if (!m.content.trim()) continue;
          // Extract file attachments from media paths
          const files: MessageFile[] = (m.media ?? []).map((path) => ({
            filename: path.split("/").pop() || "file",
            path,
            caption: "",
          }));

          // File-only messages (from background task delivery) and bg notifications
          // should merge into the assistant message that initiated the task.
          const isFileOnly = files.length > 0 && /^\[file:/.test(m.content.trim());
          const isBgNotification = role === "assistant" && /^[✓✗]/.test(m.content.trim()) && files.length === 0;

          if (isFileOnly || isBgNotification) {
            // Find the assistant message that has a tool_call matching this file's tool.
            // Extract tool name from notification (e.g. "✓ mofa_slides completed")
            // or from file path (e.g. "skill-output/mofa-slides-xxx/file.pptx")
            const toolHint = isBgNotification
              ? m.content.match(/[✓✗]\s*(\w+)/)?.[1] || ""
              : "";
            const fileHint = files[0]?.path?.match(/skills?[/-](\w+)/)?.[1] || "";

            // Find the originating assistant message (has tool_calls for this tool)
            let target = [...converted].reverse().find((c) =>
              c.role === "assistant" &&
              c.toolCalls.length > 0 &&
              c.toolCalls.some((tc) =>
                tc.name === toolHint ||
                tc.name?.includes(fileHint) ||
                fileHint.includes(tc.name || "---")
              )
            );

            // Fallback: last assistant message with any tool calls
            if (!target) {
              target = [...converted].reverse().find(
                (c) => c.role === "assistant" && c.toolCalls.length > 0,
              );
            }

            // Final fallback: last assistant message
            if (!target) {
              target = [...converted].reverse().find((c) => c.role === "assistant");
            }

            if (target) {
              for (const f of files) {
                if (!target.files.some((ef) => ef.path === f.path)) {
                  target.files.push(f);
                }
              }
            }
            // Skip adding as standalone bubble
          } else {
            // Parse tool_calls from API response (used for file→message matching)
            const toolCalls: { id: string; name: string; status: "complete" }[] =
              m.tool_calls
                ? m.tool_calls
                    .filter((tc) => tc.name)
                    .map((tc) => ({
                      id: tc.id || "",
                      name: tc.name || "",
                      status: "complete" as const,
                    }))
                : [];

            converted.push({
              id: nextId(),
              role,
              text: m.content,
              files,
              toolCalls,
              status: "complete",
              timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
            });
          }

          // Populate file store for the media panel
          for (const f of files) {
            addToFileStore({
              sessionId,
              filename: f.filename,
              filePath: f.path,
              caption: "",
            });
          }
        }
        if (converted.length > 0) {
          messagesBySession.set(sessionId, converted);
          notify();
        }
      }
      loadedSessions.add(sessionId);
    } catch {
      // API unavailable — not fatal, store stays empty
    } finally {
      loadingPromises.delete(sessionId);
    }
  })();

  loadingPromises.set(sessionId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Subscribe to messages for a specific session. */
export function useMessages(sessionId: string): Message[] {
  return useSyncExternalStore(
    subscribe,
    () => getMessageSnapshot(sessionId),
    () => getMessageSnapshot(sessionId),
  );
}
