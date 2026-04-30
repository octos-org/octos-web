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
import * as ThreadStore from "@/store/thread-store";
import { displayFilenameFromPath } from "@/lib/utils";
import { getMessages as fetchSessionMessages } from "@/api/sessions";
import { dispatchCrewFileEvent } from "./file-events";
import { recordRuntimeCounter } from "./observability";
import { eventSessionId, eventTopic } from "./event-scope";

/**
 * M8.10 PR #3: feature flag — when set to "1", route SSE events through the
 * new thread-by-cmid `thread-store.ts` instead of the flat-list
 * `message-store.ts`. Default off. PR #5 flips the default and removes the
 * flat-list path. The flag is read fresh each `bindStreamToAssistant` call
 * so toggling in DevTools takes effect on the next user message without a
 * page reload.
 */
function isThreadStoreEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("octos_thread_store_v2") === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session-scoped tool-call key map (M8.10 follow-up #649).
//
// Background tasks (spawn_only tools) start a tool_call inside one stream
// and finalize via tool_progress / tool_end / file events that may arrive
// **after** the originating stream closed — possibly minutes later, on a
// different SSE connection bound to a newer user turn. The earlier per-
// stream `keyByServerId` map evaporated when its closure went out of
// scope, so the late event lost its server-id → local-key mapping and
// fell through to `activeToolByName` lookups inside the *new* stream
// closure, mis-binding the result to the latest user bubble.
//
// Hoisting the map to a module-level, per-session container keeps the
// mapping live for the lifetime of the session so late events still find
// their bubble. Cleared explicitly only when a session is closed (no need
// to GC: real sessions hold ≤ a few hundred tool calls and the entries
// are tiny strings).
// ---------------------------------------------------------------------------

/** Per-session map of per-thread streaming-text accumulators. Keyed by
 *  the same `sessionScopeKey` as the tool maps so a thread's accumulated
 *  text survives bridge closure churn (e.g. tab refocus, page reload,
 *  retry-fetch creating a fresh `bindStreamToAssistant`). Without this
 *  durability, a `replace` on connection 1 would set `Hello`, the
 *  bridge would tear down, and a `token` ` there` arriving on connection
 *  2 would overwrite ThreadStore with just ` there` — the codex 2nd-
 *  opinion split-connection regression. */
const sessionRawTextByThread = new Map<string, Map<string, string>>();

/** Per-session map: server-issued tool_call_id (or tool_id) → local key. */
const sessionKeyByServerId = new Map<string, Map<string, string>>();
/** Per-session map: local key → tool call snapshot (id, name, status, progress). */
interface ToolCallSnapshot {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  progress: { message: string; ts: number }[];
}
const sessionToolCalls = new Map<string, Map<string, ToolCallSnapshot>>();

function sessionScopeKey(sessionId: string, topic?: string): string {
  const t = topic?.trim();
  return t ? `${sessionId}#${t}` : sessionId;
}

function getKeyByServerIdMap(scope: string): Map<string, string> {
  let m = sessionKeyByServerId.get(scope);
  if (!m) {
    m = new Map();
    sessionKeyByServerId.set(scope, m);
  }
  return m;
}

function getToolCallsMap(scope: string): Map<string, ToolCallSnapshot> {
  let m = sessionToolCalls.get(scope);
  if (!m) {
    m = new Map();
    sessionToolCalls.set(scope, m);
  }
  return m;
}

function getRawTextByThreadMap(scope: string): Map<string, string> {
  let m = sessionRawTextByThread.get(scope);
  if (!m) {
    m = new Map();
    sessionRawTextByThread.set(scope, m);
  }
  return m;
}

/** Drop the session-scoped tool-call maps. Call when a session is closed
 *  / reset to free memory. Safe to omit — the maps are tiny. */
export function clearSessionToolMaps(sessionId: string, topic?: string): void {
  const t = topic?.trim();
  if (t) {
    const scope = sessionScopeKey(sessionId, t);
    sessionKeyByServerId.delete(scope);
    sessionToolCalls.delete(scope);
    sessionRawTextByThread.delete(scope);
    return;
  }
  // No topic → drop the bare session and any per-topic descendants.
  for (const k of [...sessionKeyByServerId.keys()]) {
    if (k === sessionId || k.startsWith(`${sessionId}#`)) {
      sessionKeyByServerId.delete(k);
    }
  }
  for (const k of [...sessionToolCalls.keys()]) {
    if (k === sessionId || k.startsWith(`${sessionId}#`)) {
      sessionToolCalls.delete(k);
    }
  }
  for (const k of [...sessionRawTextByThread.keys()]) {
    if (k === sessionId || k.startsWith(`${sessionId}#`)) {
      sessionRawTextByThread.delete(k);
    }
  }
}

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

/**
 * Per-thread streaming-text accumulator.
 *
 * Called from the SSE bridge for each `token` / `replace` event the
 * subscriber observes. Returns the FULL post-event text for that
 * thread so the caller can route it to ThreadStore.replaceAssistantText
 * with the right (thread_id, text) pair.
 *
 * Pre-fix the bridge accumulated into a single `rawText` variable per
 * stream closure — when two concurrent turns on the same chat
 * interleaved, the wrong turn's rawText got passed to ThreadStore. The
 * overflow-stress mini1 (#680 follow-up) regression. Codex review caught
 * this in 2nd-opinion.
 *
 * Exported for unit testing.
 */
export function applyPerThreadTextEvent(
  acc: Map<string, string>,
  threadId: string,
  kind: "token" | "replace",
  text: string,
): string {
  if (kind === "replace") {
    acc.set(threadId, text);
    return text;
  }
  // kind === "token"
  const next = (acc.get(threadId) ?? "") + text;
  acc.set(threadId, next);
  return next;
}

/**
 * Test-only accessor for the session-scoped per-thread streaming-text
 * accumulator map. Exposed so the regression test for split-connection
 * persistence (codex 2nd-opinion follow-up) can drive the scope key
 * directly without reaching through `bindStreamToAssistant` and the
 * full SSE plumbing.
 */
export function __getRawTextByThreadMapForTest(
  sessionId: string,
  topic?: string,
): Map<string, string> {
  return getRawTextByThreadMap(sessionScopeKey(sessionId, topic));
}

/**
 * Test-only reset for the session-scoped maps. Mirrors
 * `clearSessionToolMaps` plus the per-thread raw text map.
 */
export function __resetSessionStateForTest(): void {
  sessionKeyByServerId.clear();
  sessionToolCalls.clear();
  sessionRawTextByThread.clear();
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

  // 1b. Mirror the user message into the thread store when the feature flag
  //     is on — keeps both stores populated so the renderer can flag-switch
  //     without losing state. PR #4 makes the thread store the rendered
  //     source of truth; PR #5 deletes the flat-list path.
  if (isThreadStoreEnabled()) {
    ThreadStore.addUserMessage(sessionId, {
      text,
      clientMessageId,
      files: localFiles,
      topic: historyTopic,
    });
  }

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
  // Per-thread streaming-text accumulator. Pre-fix this was a single
  // `rawText` shared across every event the subscriber saw, so when two
  // concurrent turns on the same chat interleaved their `token` /
  // `replace` events the wrong turn's text bled into the right turn's
  // bubble (overflow-stress mini1 #680 follow-up; codex review).
  // The MessageStore (legacy flat-list) path still uses the legacy
  // `assistantMsgId` key, so we keep one accumulator for it (the
  // dominant-turn `rawText`) and one per-thread map for ThreadStore.
  // The legacy path is gated behind the v2 flag — when v2 is on, the
  // ThreadStore values are authoritative. When v2 is off, only `rawText`
  // is consulted (concurrent same-chat overflow is a v2-only invariant).
  // Codex 2nd-opinion follow-up: the per-thread accumulator must be
  // session-scoped (NOT per-bridge-closure). A turn whose `replace`
  // arrives on connection 1 and `token` deltas on connection 2 (page
  // reload, retry-fetch, multi-tab) needs the prior text to persist —
  // a fresh closure-local Map would lose the prefix and overwrite the
  // thread's text with just the suffix.
  let rawText = "";
  let toolCallCounter = 0;
  const pendingStreamError = { current: null as string | null };
  const normalizedHistoryTopic = historyTopic?.trim() || undefined;
  const scope = sessionScopeKey(sessionId, normalizedHistoryTopic);
  // Session-scoped maps survive across stream closures — necessary for
  // spawn_only / background tasks whose tool_progress / tool_end / file
  // events can arrive minutes after the originating stream ended (#649).
  const toolCalls = getToolCallsMap(scope);
  const keyByServerId = getKeyByServerIdMap(scope);
  /** Session-scoped per-thread streaming-text accumulator. Survives
   *  bridge closure churn (page reload, retry-fetch, tab refocus) so
   *  a turn whose `replace` arrived on a previous connection still
   *  has its prefix when a `token` delta arrives on a new one. */
  const rawTextByThread = getRawTextByThreadMap(scope);
  /** Per-stream snapshot of just the tool calls started in THIS stream.
   *  Drives the legacy MessageStore assistant-bubble rendering (which
   *  expects per-message tool calls, not per-session). The v2 ThreadStore
   *  path uses the session-scoped `toolCalls` above instead. */
  const streamLocalToolCallKeys = new Set<string>();
  /** Maps tool name to the most recent toolCall key (for tool_end matching).
   *  Per-stream by design: this is only used as a *fallback* for legacy
   *  daemons that omit tool_call_id. Cross-stream tool name collisions
   *  would mis-route, so we keep this scoped to the current stream. */
  const activeToolByName = new Map<string, string>();

  const streamToolCallsForLegacyView = (): ToolCallSnapshot[] =>
    Array.from(streamLocalToolCallKeys)
      .map((k) => toolCalls.get(k))
      .filter((tc): tc is ToolCallSnapshot => tc !== undefined);

  // M8.10 PR #3: snapshot the flag once per stream so toggling mid-stream
  // doesn't tear data across two stores. The bridge mirrors data into the
  // thread store when on; the existing flat-list path remains authoritative
  // until PR #5 flips the default and removes it.
  const threadStoreEnabled = isThreadStoreEnabled();

  /** Resolve the thread_id for an event.
   *
   * Trust `event.thread_id` whenever it is present — the daemon now stamps
   * it on every emitted SSE event (octos PRs #664 wire + #673 persisted)
   * so the client must NOT override it with the active-stream cmid.
   * Sticky-stream cmid was the M8.10 thread-binding bug: a late
   * background-task tool_progress arriving on a stream rooted at a
   * different turn would adopt that newer turn's cmid and the result
   * would render under the wrong user bubble.
   *
   * The clientMessageId fallback only fires when the server omitted the
   * field (legacy daemons / theoretical edge case — should be never on
   * the post-#664+#673 wire). The synthesizer is a last resort. */
  const resolveThreadIdForEvent = (
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
        // Resolve the event's thread_id BEFORE mutating the legacy
        // single `rawText`. Per-thread accumulation via the helper:
        // only the matching thread's text advances, so concurrent
        // same-chat turns can never bleed text across each other.
        const tid = resolveThreadIdForEvent(event.thread_id);
        if (tid) {
          const next = applyPerThreadTextEvent(
            rawTextByThread,
            tid,
            "token",
            event.text,
          );
          if (threadStoreEnabled) {
            ThreadStore.replaceAssistantText(tid, clean(next));
          }
        }
        // Legacy MessageStore path: only advance the per-stream rawText
        // when this event matches THIS bridge's bound clientMessageId.
        // Otherwise we would splice another turn's text into this
        // bubble (the overflow-stress content-mispair signature).
        if (!clientMessageId || tid === clientMessageId) {
          rawText += event.text;
          MessageStore.updateMessage(sessionId, assistantMsgId, {
            text: clean(rawText),
          }, historyTopic);
        }
        break;
      }

      case "replace": {
        const tid = resolveThreadIdForEvent(event.thread_id);
        if (tid) {
          const next = applyPerThreadTextEvent(
            rawTextByThread,
            tid,
            "replace",
            event.text,
          );
          if (threadStoreEnabled) {
            ThreadStore.replaceAssistantText(tid, clean(next));
          }
        }
        if (!clientMessageId || tid === clientMessageId) {
          rawText = event.text;
          MessageStore.updateMessage(sessionId, assistantMsgId, {
            text: clean(rawText),
          }, historyTopic);
        }
        break;
      }

      case "tool_start": {
        // Prefer the server-issued tool_call_id (then the legacy
        // tool_id) so tool_progress and tool_end can route by id;
        // synthesize an id only when the backend omits both.
        const tcId =
          event.tool_call_id ||
          event.tool_id ||
          `tc_${event.tool}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        // Re-use the local key when we already saw this server id (e.g.
        // a tool_start replay) so the entry doesn't duplicate. Otherwise
        // derive a stable key from the server id so cross-stream lookups
        // resolve consistently.
        const key =
          (event.tool_call_id && keyByServerId.get(event.tool_call_id)) ||
          (event.tool_id && keyByServerId.get(event.tool_id)) ||
          `tc_${tcId}_${++toolCallCounter}`;
        toolCalls.set(key, {
          id: tcId,
          name: event.tool,
          status: "running",
          progress: toolCalls.get(key)?.progress ?? [],
        });
        streamLocalToolCallKeys.add(key);
        activeToolByName.set(event.tool, key);
        // Map every server-issued id we know about to this local key so
        // tool_progress / tool_end events can route by either field.
        if (event.tool_call_id) keyByServerId.set(event.tool_call_id, key);
        if (event.tool_id) keyByServerId.set(event.tool_id, key);
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          toolCalls: streamToolCallsForLegacyView(),
        }, historyTopic);
        if (threadStoreEnabled) {
          const tid = resolveThreadIdForEvent(event.thread_id);
          if (tid) ThreadStore.addToolCall(tid, tcId, event.tool);
        }
        break;
      }

      case "tool_end": {
        const key =
          (event.tool_call_id && keyByServerId.get(event.tool_call_id)) ||
          (event.tool_id && keyByServerId.get(event.tool_id)) ||
          activeToolByName.get(event.tool);
        const tc = key ? toolCalls.get(key) : undefined;
        if (tc) tc.status = event.success ? "complete" : "error";
        MessageStore.updateMessage(sessionId, assistantMsgId, {
          toolCalls: streamToolCallsForLegacyView(),
        }, historyTopic);
        if (threadStoreEnabled) {
          const tid = resolveThreadIdForEvent(event.thread_id);
          // Use the server-issued id first so a late tool_end on a
          // different stream still finds the right entry by id, even
          // if the local snapshot was already finalized away.
          const targetTcId = event.tool_call_id ?? event.tool_id ?? tc?.id;
          if (tid && targetTcId) {
            ThreadStore.setToolCallStatus(
              tid,
              targetTcId,
              event.success ? "complete" : "error",
            );
          }
        }
        break;
      }

      case "tool_progress": {
        // Anchor the entry to its tool call when the backend gave us
        // an id. Otherwise fall back to most-recent-by-name so older
        // streams still surface something in the right bubble. The
        // session-scoped maps mean late tool_progress events for a
        // background task whose tool_start fired in an earlier stream
        // still resolve to the right local entry.
        const key =
          (event.tool_call_id && keyByServerId.get(event.tool_call_id)) ||
          (event.tool_id && keyByServerId.get(event.tool_id)) ||
          activeToolByName.get(event.tool);
        const tc = key ? toolCalls.get(key) : undefined;
        if (tc) {
          tc.progress.push({ message: event.message, ts: Date.now() });
          MessageStore.updateMessage(sessionId, assistantMsgId, {
            toolCalls: streamToolCallsForLegacyView(),
          }, historyTopic);
        }
        if (threadStoreEnabled) {
          const tid = resolveThreadIdForEvent(event.thread_id);
          // Prefer the server-issued ids first so the entry matches the
          // tool_start (which writes them into the thread store).
          const targetTcId = event.tool_call_id ?? event.tool_id ?? tc?.id;
          if (tid && targetTcId) {
            ThreadStore.appendToolProgress(tid, targetTcId, event.message);
          }
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
          const attached = MessageStore.appendFileByToolCallId(
            sessionId,
            event.tool_call_id,
            file,
            historyTopic,
          );
          if (!attached) {
            MessageStore.appendFileToBackgroundAnchor(
              sessionId,
              file,
              historyTopic,
            );
          }

          if (threadStoreEnabled) {
            const tid = resolveThreadIdForEvent(event.thread_id);
            if (tid) ThreadStore.appendAssistantFile(tid, file);
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
        MessageStore.bindBackgroundTask(sessionId, event.task, historyTopic);
        window.dispatchEvent(
          new CustomEvent("crew:task_status", {
            detail: { task: event.task, sessionId, topic: historyTopic },
          }),
        );
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
        const tid = resolveThreadIdForEvent(event.thread_id);
        // `ownsLegacy` gates every legacy MessageStore side effect of
        // `done` — including the bubble status flip, meta annotation,
        // background-anchor registration, and the `onComplete` callback.
        // Without this gate, a `done` for sibling thread A would still
        // mark THIS bridge's bubble (bound to clientMessageId B) as
        // complete and fire B's onComplete, even though B's own done
        // hasn't arrived yet. Codex 2nd-opinion review.
        const ownsLegacy = !clientMessageId || tid === clientMessageId;

        // Use the per-thread accumulator for ThreadStore — never the
        // legacy chat-wide `rawText` which may hold a sibling turn's
        // content. The chat-wide `rawText` continues to drive the
        // legacy MessageStore path, but is only advanced for matching
        // events (token/replace handlers above).
        const threadRaw =
          (tid && rawTextByThread.get(tid)) ||
          (event.content ?? (ownsLegacy ? rawText : ""));
        const finalThreadText = clean(threadRaw);
        if (event.content && ownsLegacy) {
          rawText = event.content;
        }
        const finalLegacyText = clean(rawText);
        if (ownsLegacy) {
          MessageStore.updateMessage(sessionId, assistantMsgId, {
            text: finalLegacyText,
            status: "complete",
          }, historyTopic);
        }

        if (threadStoreEnabled) {
          if (tid) {
            // Replace text first so the finalized message holds the cleaned
            // final text rather than the raw token stream.
            ThreadStore.replaceAssistantText(tid, finalThreadText);
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
            // Drop the per-thread accumulator now that this thread has
            // finalized — keeps the session map bounded and prevents a
            // stale prefix from contaminating any future re-bind on the
            // same cmid (which shouldn't happen by design, but guards
            // against double-finalize replays).
            rawTextByThread.delete(tid);
          }
        }

        if (ownsLegacy && (event.model || event.tokens_in || event.tokens_out)) {
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

        // Detect queue/adaptive mode changes from command responses.
        // Use the legacy text — the global mode-update detector is keyed
        // off whichever turn's done event fires; it's not thread-scoped.
        if (ownsLegacy) {
          detectModeUpdate(finalLegacyText, sessionId);
        }

        // Clear thinking state — global per-session, fires on every done
        // (any turn's completion ends the "thinking" indicator).
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
        if (ownsLegacy && event.has_bg_tasks) {
          MessageStore.registerBackgroundAnchor(
            sessionId,
            assistantMsgId,
            historyTopic,
            streamToolCallsForLegacyView().map((toolCall) => toolCall.name),
          );
          window.dispatchEvent(
            new CustomEvent("crew:bg_tasks", {
              detail: { sessionId, topic: historyTopic },
            }),
          );
        }

        if (ownsLegacy) {
          onComplete?.();
        }
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
