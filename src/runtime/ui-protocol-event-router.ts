/**
 * UI Protocol v1 → ThreadStore action router (Phase C-2, issue #68).
 *
 * Pure mapping layer. Each handler converts a typed bridge event into the
 * same ThreadStore mutations the SSE bridge already produces, so the v1
 * transport reaches an identical store state from a different wire format.
 * The bridge-level fail-closed guards (ui-protocol-bridge.ts) have already
 * rejected malformed events before anything reaches this module.
 *
 * Capability negotiation: picks option (A) per the C-2 plan — no current
 * mapping branches on `UiProtocolCapabilities`, so we use the bridge as-is.
 *
 * Side-effects this module is allowed to perform:
 *   - mutate ThreadStore (the canonical v1 invariant)
 *   - dispatch DOM CustomEvents (`crew:thinking`, `crew:approval_requested`,
 *     `crew:bg_tasks`) so existing listeners (sidebar spinner, future
 *     approval modal) keep working without per-listener flag-gating.
 *
 * Side-effects this module deliberately does NOT perform:
 *   - touch MessageStore (the legacy flat-list path is reserved for SSE
 *     bridge; the v1 flag implicitly forces v2 thread store)
 *   - mutate session-context state directly (callers wire that up)
 */

import type {
  ApprovalRequestedEvent,
  MessageDeltaEvent,
  MessagePersistedEvent,
  PersistedMessage,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnStartedEvent,
  UiProtocolBridge,
} from "./ui-protocol-bridge";
import * as ThreadStore from "@/store/thread-store";
import type { MessageInfo } from "@/api/types";

// ---------------------------------------------------------------------------
// Per-task state-transition de-dupe
// ---------------------------------------------------------------------------

/** Last-seen task state per `task_id`. Mirrors the SSE-side
 *  `lastTaskStatusById` map in `runtime-provider.tsx` so a `task/updated`
 *  replay (e.g. on reconnect) doesn't inflate the in-bubble timeline. */
const lastTaskStateById = new Map<string, string>();

/** Reset the per-task state map. Tests call this between cases; production
 *  code does not need it because the map is bounded by the number of live
 *  tasks per session (~tens, never thousands). */
export function __resetRouterStateForTest(): void {
  lastTaskStateById.clear();
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RouterConfig {
  sessionId: string;
  /** Optional thread topic (matches the SSE-bridge `historyTopic`). */
  topic?: string;
  /** Override window event dispatch for tests / SSR. */
  dispatchEvent?: (event: Event) => void;
}

function dispatch(cfg: RouterConfig, event: Event): void {
  const fn = cfg.dispatchEvent ?? defaultDispatch;
  fn(event);
}

function defaultDispatch(event: Event): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * Translate the bridge's `PersistedMessage` shape into the `MessageInfo`
 * shape that `ThreadStore.appendPersistedMessage` expects. Only the fields
 * the store actually consults are filled in — extras are dropped because
 * the helper validates by role + thread_id and ignores unknown keys.
 */
function persistedToMessageInfo(m: PersistedMessage): MessageInfo {
  return {
    role: m.role,
    content: m.content,
    thread_id: m.thread_id,
    client_message_id: m.client_message_id,
    response_to_client_message_id: m.response_to_client_message_id,
    tool_call_id: m.source_tool_call_id,
    timestamp: m.timestamp ?? new Date().toISOString(),
    seq: typeof m.history_seq === "number" ? m.history_seq : undefined,
    intra_thread_seq:
      typeof m.intra_thread_seq === "number" ? m.intra_thread_seq : undefined,
    media: (m.files ?? []).map((f) => f.path),
    tool_calls: m.tool_calls?.map((tc) => {
      const o = tc as { id?: unknown; name?: unknown };
      return {
        id: typeof o?.id === "string" ? o.id : undefined,
        name: typeof o?.name === "string" ? o.name : undefined,
      };
    }),
  };
}

export function handleMessageDelta(
  _cfg: RouterConfig,
  event: MessageDeltaEvent,
): void {
  // turn_id is the thread_id key per the v1 contract. The bridge already
  // rejected events with a missing/empty turn_id at the guard layer.
  if (!event.delta) return;
  ThreadStore.appendAssistantToken(event.turn_id, event.delta);
}

export function handleMessagePersisted(
  cfg: RouterConfig,
  event: MessagePersistedEvent,
): void {
  const m = event.message;
  // Codex review #2: when an assistant `message/persisted` arrives for a
  // thread with an in-flight `pendingAssistant`, promote the pending
  // bubble into the persisted record instead of appending a separate
  // response. This avoids duplicate bubbles when the server emits
  // streamed deltas + persisted + completed for the same turn.
  //
  // Match conditions:
  //   - role === "assistant" (tool/user persists are independent records)
  //   - the thread's pendingAssistant exists in the live store
  //
  // When matched: overwrite the pending text/files with the canonical
  // persisted content (server is authoritative on final text) and call
  // `finalizeAssistant` with the persisted seq. The downstream
  // `turn/completed` then no-ops because `pendingAssistant` is null.
  //
  // When unmatched (no pending, e.g. late artifact, or non-assistant
  // role): fall through to `appendPersistedMessage` — the PR M
  // late-artifact path.
  if (m.role === "assistant" && m.thread_id) {
    const promoted = tryPromotePendingFromPersisted(
      cfg.sessionId,
      cfg.topic,
      m,
    );
    if (promoted) return;
  }
  ThreadStore.appendPersistedMessage(
    cfg.sessionId,
    cfg.topic,
    persistedToMessageInfo(m),
  );
}

/**
 * If the live thread for `m.thread_id` has an in-flight pendingAssistant,
 * overwrite its content/files with the persisted record and finalize.
 * Returns true when promotion happened (caller should NOT also append).
 */
function tryPromotePendingFromPersisted(
  sessionId: string,
  topic: string | undefined,
  m: PersistedMessage,
): boolean {
  const threads = ThreadStore.getThreads(sessionId, topic);
  const thread = threads.find((t) => t.id === m.thread_id);
  if (!thread || !thread.pendingAssistant) return false;
  // Replace pending text + files with the persisted content. Files
  // from the persisted record win; the streamed pending text was a
  // best-effort approximation of what's now authoritative.
  ThreadStore.replaceAssistantText(m.thread_id, m.content);
  // appendAssistantFile is path-deduped, so re-adding a streamed file
  // is a no-op. Persisted files that weren't already attached land here.
  for (const f of m.files ?? []) {
    ThreadStore.appendAssistantFile(m.thread_id, {
      filename: filenameFromPath(f.path),
      path: f.path,
      caption: "",
    });
  }
  ThreadStore.finalizeAssistant(m.thread_id, {
    committedSeq:
      typeof m.intra_thread_seq === "number"
        ? m.intra_thread_seq
        : typeof m.history_seq === "number"
          ? m.history_seq
          : undefined,
  });
  return true;
}

function filenameFromPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

export function handleTaskUpdated(
  cfg: RouterConfig,
  event: TaskUpdatedEvent,
): void {
  const previous = lastTaskStateById.get(event.task_id);
  if (previous === event.state) return;
  lastTaskStateById.set(event.task_id, event.state);

  switch (event.state) {
    case "spawned":
    case "running": {
      const label = event.title ?? event.runtime_detail ?? event.state;
      ThreadStore.appendToolProgress(event.turn_id, event.task_id, label);
      // Mirror the legacy SSE bridge's `crew:bg_tasks` dispatch so any
      // listener that gates a session-level "background work" indicator
      // off the same event keeps firing.
      dispatch(
        cfg,
        new CustomEvent("crew:bg_tasks", {
          detail: { sessionId: cfg.sessionId, topic: cfg.topic },
        }),
      );
      break;
    }
    case "completed": {
      ThreadStore.setToolCallStatus(event.turn_id, event.task_id, "complete");
      break;
    }
    case "failed":
    case "errored": {
      ThreadStore.setToolCallStatus(event.turn_id, event.task_id, "error");
      break;
    }
    default:
      break;
  }
}

export function handleTaskOutputDelta(
  _cfg: RouterConfig,
  event: TaskOutputDeltaEvent,
): void {
  if (!event.chunk) return;
  // Surface live tool stdout into the bubble's progress timeline. Dedupe
  // logic lives in ThreadStore.appendToolProgress (consecutive duplicates
  // are dropped) so resending the same chunk on reconnect is safe.
  ThreadStore.appendToolProgress(event.turn_id, event.task_id, event.chunk);
}

export function handleTurnStarted(
  cfg: RouterConfig,
  event: TurnStartedEvent,
): void {
  // Mirror the legacy `crew:thinking` rising edge so the global indicator
  // (sidebar spinner, header pulse) lights up the moment a turn begins.
  // ThreadStore-side bookkeeping is handled by `addUserMessage` on send;
  // we do not synthesize a placeholder here because the user bubble is
  // already in place by the time the server confirms turn/started.
  dispatch(
    cfg,
    new CustomEvent("crew:thinking", {
      detail: {
        thinking: true,
        iteration: 0,
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        turnId: event.turn_id,
      },
    }),
  );
}

export function handleTurnCompleted(
  cfg: RouterConfig,
  event: TurnCompletedEvent,
): void {
  ThreadStore.finalizeAssistant(event.turn_id);
  dispatch(
    cfg,
    new CustomEvent("crew:thinking", {
      detail: {
        thinking: false,
        iteration: 0,
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        turnId: event.turn_id,
      },
    }),
  );
}

export function handleTurnError(
  cfg: RouterConfig,
  event: TurnErrorEvent,
): void {
  // Mark the bubble errored rather than leaving the pending slot dangling.
  // `finalizeAssistant` accepts an explicit status override per its options
  // surface — we use it so the v1 path produces the same terminal state
  // shape (responses[].status === "error") as the v0 SSE `error` branch.
  ThreadStore.finalizeAssistant(event.turn_id, { status: "error" });
  dispatch(
    cfg,
    new CustomEvent("crew:thinking", {
      detail: {
        thinking: false,
        iteration: 0,
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        turnId: event.turn_id,
      },
    }),
  );
  dispatch(
    cfg,
    new CustomEvent("crew:turn_error", {
      detail: {
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        turnId: event.turn_id,
        error: event.error,
      },
    }),
  );
}

export function handleApprovalRequested(
  cfg: RouterConfig,
  event: ApprovalRequestedEvent,
): void {
  // No approval modal exists yet (Phase C-4 territory). For now we surface
  // the typed event verbatim through a CustomEvent so a future modal can
  // listen without us having to touch this router again. The modal API
  // shape is the bridge's `ApprovalRequestedEvent` directly — the typed
  // shape is the contract.
  dispatch(
    cfg,
    new CustomEvent("crew:approval_requested", { detail: event }),
  );
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface RouterAttachment {
  /** Detach all subscriptions registered on the bridge. Idempotent. */
  detach(): void;
}

/**
 * Subscribe the router to all relevant streams on a started bridge. The
 * caller owns bridge lifecycle (start/stop). Returns a detacher that
 * removes every listener registered here — call it before swapping the
 * bridge out (e.g. session change) to avoid event leaks.
 */
export function attachRouter(
  bridge: UiProtocolBridge,
  cfg: RouterConfig,
): RouterAttachment {
  const offMessageDelta = bridge.onMessageDelta((e) =>
    handleMessageDelta(cfg, e),
  );
  const offMessagePersisted = bridge.onMessagePersisted((e) =>
    handleMessagePersisted(cfg, e),
  );
  const offTaskUpdated = bridge.onTaskUpdated((e) => handleTaskUpdated(cfg, e));
  const offTaskOutputDelta = bridge.onTaskOutputDelta((e) =>
    handleTaskOutputDelta(cfg, e),
  );
  const offTurnLifecycle = bridge.onTurnLifecycle((e) => {
    // The bridge muxes the three lifecycle events through a single
    // subscriber for ergonomics. Discriminate by the field that is unique
    // per event variant: `error` only on `TurnErrorEvent`, `reason` only
    // on `TurnCompletedEvent`. `TurnStartedEvent` is the residual.
    if ("error" in e) {
      handleTurnError(cfg, e);
      return;
    }
    if ("reason" in e) {
      handleTurnCompleted(cfg, e);
      return;
    }
    handleTurnStarted(cfg, e);
  });
  const offApprovalRequested = bridge.onApprovalRequested((e) =>
    handleApprovalRequested(cfg, e),
  );

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      offMessageDelta();
      offMessagePersisted();
      offTaskUpdated();
      offTaskOutputDelta();
      offTurnLifecycle();
      offApprovalRequested();
    },
  };
}
