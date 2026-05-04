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
 * Translate the flat `MessagePersistedEvent` (UPCR-2026-012 wire shape;
 * server P1.3 fix in PR #767) into the `MessageInfo` shape that
 * `ThreadStore.appendPersistedMessage` expects, for the late-artifact
 * path (no live `pendingAssistant` to promote).
 *
 * The wire shape is metadata-only — there is no `content` field. We
 * synthesize a minimal placeholder when `media` is present so the bubble
 * has visible text alongside the `<a href>` (the file URL itself is
 * carried via `MessageInfo.media`). For text-only persists with no live
 * pending and no media, we synthesise an empty `content` — the row is
 * still recorded with its seq/role so `session/hydrate` can later replace
 * it with the canonical text.
 */
function eventToMessageInfo(event: MessagePersistedEvent): MessageInfo {
  const media = event.media ?? [];
  // Empty `content` (NOT a synthesised placeholder) is required so
  // `ThreadStore.appendPersistedMessage` recognises this as a
  // media-only companion row and merges it into the existing assistant
  // response — the merge predicate only treats empty/whitespace or
  // `[file: ...]` marker text as media-only (`thread-store.ts:702`).
  // The attachment renderer makes the bubble visible without text.
  return {
    role: event.role,
    content: "",
    thread_id: event.thread_id,
    client_message_id: event.client_message_id,
    response_to_client_message_id: undefined,
    tool_call_id: undefined,
    timestamp: event.persisted_at,
    seq: event.seq,
    intra_thread_seq: undefined,
    media,
    tool_calls: undefined,
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
  // The wire shape per UPCR-2026-012 is metadata-only — there is no
  // `content` field. Final text is the streamed `pendingAssistant.text`
  // accumulated from `message/delta`; this event finalises the bubble
  // and (since server PR #767) carries the row's `media` attachments.
  //
  // Two cases:
  //
  //   (1) Match condition (assistant role + thread_id resolves to a
  //       thread with `pendingAssistant`): keep the streamed text,
  //       append each `media` URL to the pending bubble, then finalise
  //       with the event's `seq`. The downstream `turn/completed`
  //       no-ops because `pendingAssistant` is null after this.
  //
  //   (2) Unmatched (no pending — late artifact, non-assistant role,
  //       or assistant whose live pending was lost across reconnect):
  //       fall through to `appendPersistedMessage` so a fresh row
  //       appears in the thread. The bubble shows the synthesised
  //       placeholder content + the `media` URL.
  if (event.role === "assistant" && event.thread_id) {
    const promoted = tryPromotePendingFromPersisted(
      cfg.sessionId,
      cfg.topic,
      event,
    );
    if (promoted) return;
  }
  ThreadStore.appendPersistedMessage(
    cfg.sessionId,
    cfg.topic,
    eventToMessageInfo(event),
  );
}

/**
 * If the live thread for `event.thread_id` has an in-flight
 * pendingAssistant, append the event's `media` URLs to the pending
 * bubble and finalise it with the event's `seq`. Returns true when
 * promotion happened (caller should NOT also append a fresh row).
 *
 * Unlike the original promotion path, this DOES NOT overwrite the
 * pending text — the server's `MessagePersistedEvent` carries no
 * `content` field, so the streamed `message/delta` text is
 * authoritative for the bubble's body.
 */
function tryPromotePendingFromPersisted(
  sessionId: string,
  topic: string | undefined,
  event: MessagePersistedEvent,
): boolean {
  const threadId = event.thread_id;
  if (!threadId) return false;
  const threads = ThreadStore.getThreads(sessionId, topic);
  const thread = threads.find((t) => t.id === threadId);
  if (!thread || !thread.pendingAssistant) return false;
  // appendAssistantFile is path-deduped, so re-adding a streamed file is
  // a no-op. New media URLs that weren't already attached land here.
  for (const path of event.media ?? []) {
    ThreadStore.appendAssistantFile(threadId, {
      filename: filenameFromPath(path),
      path,
      caption: "",
    });
  }
  ThreadStore.finalizeAssistant(threadId, {
    committedSeq: event.seq,
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
