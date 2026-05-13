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
  ProgressUpdatedEvent,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  ToolCompletedEvent,
  ToolProgressEvent,
  ToolStartedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnSpawnCompleteEvent,
  TurnStartedEvent,
  UiProtocolBridge,
} from "./ui-protocol-bridge";
import * as ThreadStore from "@/store/thread-store";
import type { MessageMeta } from "@/store/thread-store";
import type { MessageInfo } from "@/api/types";

// ---------------------------------------------------------------------------
// Per-turn meta snapshot
// ---------------------------------------------------------------------------
//
// Regression-#2 fix (chat-thread `ThreadMessageMeta` footer):
//
// PR #93 narrowed the wire shape of `MessagePersistedEvent` to
// metadata-only (`{message_id, persisted_at, media}`); model + tokens +
// duration migrated to `progress/updated` notifications carrying
// `metadata.kind === "token_cost_update"`. The legacy
// `ThreadMessageMeta` renderer reads `message.meta.{model, tokens_in,
// tokens_out, duration_s}` and goes blank when meta is absent.
//
// We accumulate the latest cost snapshot per `turn_id` here and stamp it
// onto the finalised assistant bubble via `finalizeAssistant({ meta })`
// when `turn/completed` lands. The snapshot survives across multiple
// `progress/updated` frames in a turn so a late cost frame between the
// first delta and the completion doesn't drop fields. Clear on
// `turn/completed` / `turn/error` so a stale snapshot can't leak into a
// following turn.

interface TurnMetaSnapshot {
  /** Last model string we saw. Populated from `metadata.label` (the
   *  server's display-name carrier; see
   *  `crates/octos-cli/src/api/ui_protocol_progress.rs:363` and
   *  follow-up). Optional — some turns don't carry a model. */
  model?: string;
  /** Per-turn delta of `input_tokens`. Codex round-2 P2 fix: the
   *  `progress/updated{kind:"token_cost_update"}` frame carries SESSION
   *  cumulative counters (server `emit_cost_update`'s
   *  `total_usage.input_tokens` —
   *  `crates/octos-agent/src/agent/streaming.rs:256`), so stamping the
   *  raw counter onto `message.meta` would show session-total tokens on
   *  every assistant bubble after the first turn. We derive the
   *  per-turn delta by anchoring on `baselineInputTokens` (the
   *  cumulative value at the first frame we see for this turn) and
   *  subtracting it from every subsequent frame.
   */
  tokensIn?: number;
  tokensOut?: number;
  /** Baseline session-cumulative tokens at the start of the turn.
   *  `tokensIn` / `tokensOut` are derived as `latest - baseline`. */
  baselineInputTokens?: number;
  baselineOutputTokens?: number;
  /** Latest session-cumulative tokens seen on a `progress/updated`
   *  frame for this turn. Used by `handleTurnCompleted` to roll the
   *  session baseline forward for the next turn. */
  latestCumulativeInputTokens?: number;
  latestCumulativeOutputTokens?: number;
  /** Turn duration in seconds, rounded to one decimal place. Computed
   *  from the first `progress/updated{kind:"token_cost_update"}` arrival
   *  time relative to either `turn/started` or, lacking that, the first
   *  meta snapshot we ever recorded for the turn. */
  durationS?: number;
  /** Performance.now() (or Date.now()) at the first frame for this turn —
   *  used to derive `durationS` on `turn/completed`. */
  firstSeenAtMs?: number;
}

const turnMetaByTurnId = new Map<string, TurnMetaSnapshot>();

/** Session-cumulative token totals at the close of the most recent
 *  turn. The next turn's baseline = this value, so its per-turn delta
 *  comes out as `latest - lastTurnEndCumulative`. Keyed by `sessionId`
 *  so cross-session leakage can't happen. Codex round-2 P2 fix.
 *
 *  Codex round-4: each counter is independently optional — a server
 *  frame may carry only `output_tokens` (or only `session_cost` and
 *  no token counters at all). We seed each counter's baseline ONLY
 *  when that specific counter is observed. Otherwise a later frame's
 *  first `input_tokens` value would get attributed in full to the
 *  current turn (as if baseline=0), which is exactly the
 *  session-cumulative-leak the round-3 self-seeding heuristic tried
 *  to prevent. */
const lastTurnEndCumulativeBySession = new Map<
  string,
  { inputTokens?: number; outputTokens?: number }
>();

/** `tool_call_id` → `tool_name` map, populated by `tool/started` so a
 *  subsequent `tool/progress` (which carries no `tool_name` on the wire)
 *  can still render the friendly tool label in the spinner row. Codex
 *  P3 fix: the spinner used to flip from e.g. `shell` to `tc-abc...`
 *  the moment the first `tool/progress` arrived. The map is bounded by
 *  the number of in-flight tool calls per session (~tens, never
 *  thousands); we clear an entry on `tool/completed` to keep it tight.
 */
const toolNameByCallId = new Map<string, string>();

/** Reset the per-turn meta map + tool-name cache + cumulative
 *  baseline. Tests call this between cases; production code does not
 *  need it because all three maps are bounded by the number of live
 *  turns + tool calls + sessions. */
export function __resetTurnMetaForTest(): void {
  turnMetaByTurnId.clear();
  toolNameByCallId.clear();
  lastTurnEndCumulativeBySession.clear();
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function metaFromSnapshot(snap: TurnMetaSnapshot | undefined): MessageMeta | undefined {
  if (!snap) return undefined;
  if (!snap.model && !snap.tokensIn && !snap.tokensOut && !snap.durationS) {
    return undefined;
  }
  return {
    model: snap.model ?? "",
    tokens_in: snap.tokensIn ?? 0,
    tokens_out: snap.tokensOut ?? 0,
    duration_s: snap.durationS ?? 0,
  };
}

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
 * The wire shape is metadata-only — there is no `content` field. The
 * row's `content` is set to the empty string in both branches:
 *   - media-bearing rows: ThreadStore's media-only-merge predicate
 *     treats empty content as a companion row and merges the file into
 *     the existing assistant response;
 *   - text-only rows with no live pending: the row is still recorded
 *     with its seq/role so `session/hydrate` can later replace it with
 *     the canonical text.
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
  // The wire field is `text` (see `MessageDeltaEvent`) — using the wrong
  // field name silently drops every spawn-ack delta and leaves an empty
  // timestamp-only bubble (M10 Phase 6.2 regression).
  if (!event.text) return;
  ThreadStore.appendAssistantToken(event.turn_id, event.text);
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
  //       appears in the thread. With empty content + non-empty
  //       `media`, ThreadStore merges this into the existing
  //       assistant response as a companion row; the attachment
  //       renderer makes the file URL visible.
  if (event.role === "assistant" && event.thread_id) {
    const promoted = tryPromotePendingFromPersisted(
      cfg.sessionId,
      cfg.topic,
      event,
    );
    if (promoted) return;
    // Phantom-bubble defence (production bug 2026-05-09):
    // Multi-iteration agent loops (assistant -> tool -> assistant) emit
    // multiple `message/persisted` events per turn under the same
    // `thread_id`. The router promotes/finalises the live
    // `pendingAssistant` on the FIRST assistant persisted event for the
    // turn. The wire shape per UPCR-2026-012 is metadata-only (no
    // `content`) — every subsequent assistant persisted event for the
    // same turn carries `content=""` and (typically) `media=[]`, and
    // its streamed text already landed in the now-finalised bubble.
    // Falling through to `appendPersistedMessage` for those events
    // would synthesise an empty-content empty-media row that renders
    // as a phantom timestamp-only bubble. Drop the event when it has
    // no media (no attachment to render) — the streamed text is
    // already on the bubble we finalised earlier. Media-bearing late
    // artifacts still flow through to `appendPersistedMessage` for
    // attachment merging.
    const eventMedia = event.media ?? [];
    if (eventMedia.length === 0) {
      return;
    }
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
 * bubble. Returns true when ownership was claimed (caller should NOT
 * also append a fresh row).
 *
 * Unlike the original promotion path, this DOES NOT overwrite the
 * pending text — the server's `MessagePersistedEvent` carries no
 * `content` field, so the streamed `message/delta` text is
 * authoritative for the bubble's body.
 *
 * M10 Phase 5b empty-placeholder fix: the persistence event for an
 * assistant turn frequently arrives BEFORE the streamed `message/delta`
 * carrying the bubble's text (the server emits durable
 * `message/persisted` immediately on commit; `message/delta` is
 * ephemeral and races). Pre-fix, finalising here would freeze an
 * empty bubble — and the late delta would then be dropped by
 * `appendAssistantToken`'s `isFinalizedAndIdle` guard, surfacing as
 * a phantom-chunk-drop counter increment and an empty timestamp-only
 * placeholder. The fix: finalise here ONLY when the bubble already has
 * content (text already streamed, OR media on the event) — leaving
 * the pending alive otherwise so subsequent deltas land in it. The
 * authoritative `turn/completed` always finalises, so the bubble
 * doesn't leak even if no delta ever arrives.
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
  const eventMedia = event.media ?? [];
  for (const path of eventMedia) {
    ThreadStore.appendAssistantFile(threadId, {
      filename: filenameFromPath(path),
      path,
      caption: "",
    });
  }
  // Phase 5b empty-placeholder defence: only finalise when the bubble
  // has something to render right now. Empty pending + no-media event
  // = wait for delta or `turn/completed` rather than freezing an empty
  // row that drops the late delta. Code path stays idempotent: a
  // late `message/persisted` replay for a thread already finalized
  // returns early at the `pendingAssistant` null check above.
  //
  // Media-bearing branch: `eventMedia.length > 0` finalises
  // immediately. Server-side contract is that media-bearing
  // `message/persisted` rows are file-only — `message/delta` is
  // text-only by spec § 9 (ephemeral text stream), and the agent never
  // streams text into a row that also carries `media`. If the
  // contract ever loosens (e.g. a media row with late text delta),
  // this branch would freeze the row before the delta arrives — same
  // failure mode the no-media branch fixes — and would need a
  // matching defence.
  const pendingHasContent =
    thread.pendingAssistant.text.trim().length > 0 ||
    thread.pendingAssistant.files.length > 0 ||
    thread.pendingAssistant.toolCalls.length > 0;
  if (pendingHasContent || eventMedia.length > 0) {
    ThreadStore.finalizeAssistant(threadId, {
      committedSeq: event.seq,
    });
  } else {
    // Stamp the seq onto the pending without finalising so a later
    // `turn/completed` (which doesn't carry a per-message seq) still
    // ends up with the durable per-thread sequence stamped on the
    // committed row. No-op if pending already has this seq.
    ThreadStore.stampPendingHistorySeq(threadId, event.seq);
  }
  return true;
}

function filenameFromPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * M10 Phase 2: handle the `turn/spawn_complete` envelope.
 *
 * Each envelope is structurally complete and represents a NEW assistant
 * bubble under the originating user prompt — no merging into an existing
 * bubble, no reconstruction across events. This eliminates the splice-merge
 * bug class (sticky-map drift, phantom-chunk drop) that the legacy
 * `appendAssistantFile` / `appendPersistedMessage` paths suffer from.
 *
 * Placement strategy (per the migration plan): use `event.thread_id` as
 * the placement key — server PR #680 made `thread_id` the
 * server-authoritative identifier on persisted rows, so the SPA reducer
 * binds the new bubble against it directly. We deliberately do NOT key
 * off `response_to_client_message_id`: Phase 1 server emits a
 * thread-id-flavoured value there until Phase 4 plumbing introduces a
 * typed `originating_client_message_id`. Reading it as advisory only
 * matches the server's documented Phase 1 contract.
 *
 * Legacy fallback: if `thread_id` is missing (older callers, or paths
 * that don't propagate origination), use `response_to_client_message_id`
 * as a best-effort placement key. If neither is present, the envelope
 * cannot be attributed and is dropped — better than orphaning the bubble
 * under an arbitrary thread.
 */
export function handleSpawnComplete(
  cfg: RouterConfig,
  event: TurnSpawnCompleteEvent,
): void {
  const placementKey =
    event.thread_id ?? event.response_to_client_message_id;
  if (!placementKey) {
    return;
  }

  ThreadStore.appendCompletionBubble(placementKey, {
    text: event.content,
    media: event.media ?? [],
    spawnComplete: true,
    sourceClientMessageId: event.response_to_client_message_id,
    historySeq: event.seq,
    messageId: event.message_id,
    // Server-side commit time. Without this, the row's display timestamp
    // is client receipt time and shifts on reconnect (codex round-4 P3).
    persistedAt: event.persisted_at,
    // Pass the router's active scope so unknown-thread orphan
    // completions land in THIS session's bucket rather than an
    // arbitrary stale one (codex P2 fix).
    sessionId: cfg.sessionId,
    topic: cfg.topic,
  });
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
  //
  // Regression-#2 (bubble footer): seed a per-turn meta snapshot at
  // turn-start so the duration timer has a starting point even if no
  // intermediate `progress/updated` frame arrives.
  const snap = turnMetaByTurnId.get(event.turn_id) ?? {};
  snap.firstSeenAtMs = nowMs();
  turnMetaByTurnId.set(event.turn_id, snap);
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
  // Regression-#2 (bubble footer): stamp the accumulated per-turn meta
  // snapshot onto the finalised bubble so `ThreadMessageMeta` can render
  // model + tokens + duration. Compute the final duration from the
  // `firstSeenAtMs` anchor we set on turn/started.
  const snap = turnMetaByTurnId.get(event.turn_id);
  if (snap && snap.firstSeenAtMs !== undefined) {
    const elapsedMs = Math.max(0, nowMs() - snap.firstSeenAtMs);
    snap.durationS = Math.round((elapsedMs / 1000) * 10) / 10;
  }
  // Codex round-2/4 P2: roll the session-cumulative baseline forward
  // so the next turn's per-turn delta is correct. Use the latest
  // cumulative we saw on a cost frame this turn (per-counter); if a
  // counter never appeared this turn, preserve the existing baseline
  // for that counter rather than zeroing it.
  if (snap?.latestCumulativeInputTokens !== undefined || snap?.latestCumulativeOutputTokens !== undefined) {
    const prior = lastTurnEndCumulativeBySession.get(cfg.sessionId) ?? {};
    lastTurnEndCumulativeBySession.set(cfg.sessionId, {
      inputTokens: snap.latestCumulativeInputTokens ?? prior.inputTokens,
      outputTokens: snap.latestCumulativeOutputTokens ?? prior.outputTokens,
    });
  }
  const meta = metaFromSnapshot(snap);
  // `finalizeAssistant` is the happy path — works when the pending slot
  // is still live. Codex P2: an earlier `message/persisted` already may
  // have promoted the pending bubble (`tryPromotePendingFromPersisted`),
  // in which case `finalizeAssistant`'s pending-required guard returns
  // without applying our meta. Fall back to `patchLastResponseMeta` so
  // the meta still lands on the now-finalised response.
  ThreadStore.finalizeAssistant(event.turn_id, meta ? { meta } : {});
  if (meta) {
    ThreadStore.patchLastResponseMeta(event.turn_id, { meta });
  }
  turnMetaByTurnId.delete(event.turn_id);
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
  const snap = turnMetaByTurnId.get(event.turn_id);
  if (snap && snap.firstSeenAtMs !== undefined) {
    const elapsedMs = Math.max(0, nowMs() - snap.firstSeenAtMs);
    snap.durationS = Math.round((elapsedMs / 1000) * 10) / 10;
  }
  if (snap?.latestCumulativeInputTokens !== undefined || snap?.latestCumulativeOutputTokens !== undefined) {
    const prior = lastTurnEndCumulativeBySession.get(cfg.sessionId) ?? {};
    lastTurnEndCumulativeBySession.set(cfg.sessionId, {
      inputTokens: snap.latestCumulativeInputTokens ?? prior.inputTokens,
      outputTokens: snap.latestCumulativeOutputTokens ?? prior.outputTokens,
    });
  }
  const meta = metaFromSnapshot(snap);
  ThreadStore.finalizeAssistant(event.turn_id, {
    status: "error",
    ...(meta ? { meta } : {}),
  });
  // Codex P2: same fall-back as `handleTurnCompleted` for the
  // persisted-promoted ordering. Also stamp `status:"error"` so the
  // bubble's status changes even when persisted promoted it to
  // "complete".
  ThreadStore.patchLastResponseMeta(event.turn_id, {
    status: "error",
    ...(meta ? { meta } : {}),
  });
  turnMetaByTurnId.delete(event.turn_id);
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

// ---------------------------------------------------------------------------
// Synchronous tool-call lifecycle  (regression #1)
// ---------------------------------------------------------------------------
//
// The legacy SSE bridge (`sse-bridge.ts`, deleted in PR #96) was the sole
// dispatcher of `crew:tool_progress` DOM events — the
// `ToolProgressIndicator` component listens to that event to render the
// spinner under the streaming assistant bubble. Without a replacement,
// the spinner never lit up for any in-flight tool call.
//
// Each handler below converts the typed UI Protocol v1 envelope into the
// same `{ tool, message, sessionId, topic, turnId }` detail shape the
// component reads (see `src/components/tool-progress-indicator.tsx`).
// The component clears the spinner on `crew:thinking { thinking: false }`
// (already dispatched by `handleTurnCompleted` / `handleTurnError`), so
// no explicit clear event is needed on `tool/completed`.

function dispatchToolProgressEvent(
  cfg: RouterConfig,
  turnId: string,
  toolName: string,
  message: string,
): void {
  dispatch(
    cfg,
    new CustomEvent("crew:tool_progress", {
      detail: {
        tool: toolName,
        message,
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        turnId,
      },
    }),
  );
}

export function handleToolStarted(
  cfg: RouterConfig,
  event: ToolStartedEvent,
): void {
  toolNameByCallId.set(event.tool_call_id, event.tool_name);
  // Codex round-2 P2: mirror the synchronous tool-call lifecycle onto
  // the ThreadStore so the finalised assistant bubble carries a tool
  // card (`ToolCallBubble`), not just the transient spinner. Matches
  // the pattern `handleTaskUpdated` uses for spawn_only / background
  // tasks. `addToolCall` is idempotent on `(turn_id, tool_call_id)`,
  // so a replayed `tool/started` is safe.
  ThreadStore.addToolCall(event.turn_id, event.tool_call_id, event.tool_name);
  dispatchToolProgressEvent(cfg, event.turn_id, event.tool_name, "running");
}

export function handleToolProgress(
  cfg: RouterConfig,
  event: ToolProgressEvent,
): void {
  // The wire shape carries no `tool_name` on `tool/progress`. Codex P3:
  // the legacy SSE bridge kept rendering the tool name from the
  // preceding `tool/started`; we mirror that by consulting our
  // `toolNameByCallId` cache. Falling back to the `tool_call_id` only
  // when no cached name exists (race: progress arrives before started,
  // or a server-side bug omits the started frame entirely) keeps the
  // spinner row populated rather than blank.
  const toolLabel =
    toolNameByCallId.get(event.tool_call_id) ?? event.tool_call_id;
  const message = event.message ?? "running";
  // Codex round-2 P2: feed progress chunks into the bubble's tool
  // card timeline. `appendToolProgress` dedupes consecutive
  // duplicates so resending the same chunk on reconnect is safe.
  if (event.message) {
    ThreadStore.appendToolProgress(
      event.turn_id,
      event.tool_call_id,
      event.message,
    );
  }
  dispatchToolProgressEvent(cfg, event.turn_id, toolLabel, message);
}

export function handleToolCompleted(
  cfg: RouterConfig,
  event: ToolCompletedEvent,
): void {
  const message =
    event.success === false
      ? "error"
      : event.success === true
        ? "done"
        : "complete";
  // Codex round-2 P2: persist the terminal tool-call status onto the
  // bubble's tool card so the chip stops spinning. Failed calls
  // surface as "error"; everything else as "complete" (matching the
  // `handleTaskUpdated` `completed` / `failed` mapping).
  ThreadStore.setToolCallStatus(
    event.turn_id,
    event.tool_call_id,
    event.success === false ? "error" : "complete",
  );
  dispatchToolProgressEvent(cfg, event.turn_id, event.tool_name, message);
  // Clear the cache entry so a long-lived session doesn't accumulate
  // dead tool_call_id mappings.
  toolNameByCallId.delete(event.tool_call_id);
}

// ---------------------------------------------------------------------------
// progress/updated   (regressions #3 + #2 helper)
// ---------------------------------------------------------------------------
//
// The server emits `progress/updated` for every cost telemetry frame
// (`metadata.kind === "token_cost_update"`). The legacy SSE bridge was
// the sole dispatcher of `crew:cost` (header cost badge) and
// `crew:message_meta` (assistant-bubble footer). After PR #96 nobody
// fired them — so the header model badge and bubble footer went blank.
//
// Wire shape (see `crates/octos-core/src/ui_protocol.rs`):
//   metadata = {
//     kind: "token_cost_update",
//     label?: model display name,
//     token_cost: { input_tokens?, output_tokens?, session_cost?, ... }
//   }
//
// We dispatch two DOM events:
//
//   (a) `crew:cost` — every cost frame, with the wire field names the
//       legacy listener in `session-context.tsx:702-744` expects
//       (`input_tokens`, `output_tokens`, `session_cost`).
//
//   (b) `crew:message_meta` — only when the frame carries a model name
//       AND we already have a turn anchor (so a duration can be
//       computed). This is the cheap path for regression #2 the
//       diagnostic flagged: rather than re-architecting the bubble
//       renderer to read from `useSession()`, we keep stamping
//       `message.meta` on `finalizeAssistant` (the `handleTurnCompleted`
//       branch above) and let the legacy `crew:message_meta` listener
//       also keep flowing for any subscribers that read off the global
//       window event.

export function handleProgressUpdated(
  cfg: RouterConfig,
  event: ProgressUpdatedEvent,
): void {
  if (event.metadata.kind !== "token_cost_update") return;
  const cost = event.metadata.token_cost;
  const inputTokens = cost?.input_tokens;
  const outputTokens = cost?.output_tokens;
  const sessionCost = cost?.session_cost;
  // `metadata.label` is the server's display-name carrier (set by the
  // agent when emitting cost frames; nullable for very early frames in
  // the turn). We pass it through verbatim so the legacy listener can
  // read `detail.model`.
  const modelLabel =
    typeof event.metadata.label === "string" && event.metadata.label.length > 0
      ? event.metadata.label
      : undefined;

  // -- (a) crew:cost -------------------------------------------------------
  dispatch(
    cfg,
    new CustomEvent("crew:cost", {
      detail: {
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        turnId: event.turn_id,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        session_cost: sessionCost,
      },
    }),
  );

  // -- Update per-turn meta snapshot for regression #2 ---------------------
  //
  // Codex round-2 P2: `input_tokens` / `output_tokens` from the
  // `progress/updated{kind:"token_cost_update"}` payload are SESSION
  // cumulative counters (see `crates/octos-agent/src/agent/streaming.rs`
  // `emit_cost_update` — they're sourced from `total_usage`). For the
  // legacy `crew:cost` listener (header cost badge) that's exactly the
  // right shape — it tracks session-wide totals. For
  // `message.meta.{tokens_in, tokens_out}` (the per-bubble footer) we
  // need PER-TURN deltas, otherwise after the 2nd turn the footer
  // shows all tokens used in the session.
  //
  // The per-turn delta is `current_cumulative - baseline`, where
  // `baseline` is the cumulative total at the end of the previous turn
  // for THIS session. The first turn's baseline is 0 (no prior turns,
  // so the cumulative IS the per-turn count). `handleTurnCompleted` /
  // `handleTurnError` snapshot the session totals into
  // `lastTurnEndCumulativeBySession` so the next turn's baseline is
  // available.
  //
  // We also remember the latest cumulative counters on the snapshot
  // itself (`latestCumulativeInputTokens` / `Output`) so
  // `handleTurnCompleted` can roll the session baseline forward
  // without depending on whether the last cost frame ran first.
  if (event.turn_id) {
    const snap = turnMetaByTurnId.get(event.turn_id) ?? {};
    if (modelLabel) snap.model = modelLabel;
    // Codex round-3/4 P2: when no per-counter baseline exists yet
    // (first turn after page reload / fresh session restore), the
    // `progress/updated` payload's cumulative counters include
    // pre-reload history we never saw. Self-seed from the FIRST
    // observed value of EACH counter independently — a frame that
    // carries only `output_tokens` should NOT pin
    // `inputTokens.baseline = 0` (round-4 fix), because the next
    // frame's first `input_tokens` would then be attributed in full
    // to this turn (defeating the round-3 anti-leak).
    const existing = lastTurnEndCumulativeBySession.get(cfg.sessionId) ?? {};
    let baselineIn = existing.inputTokens;
    let baselineOut = existing.outputTokens;
    if (typeof inputTokens === "number" && baselineIn === undefined) {
      baselineIn = inputTokens;
    }
    if (typeof outputTokens === "number" && baselineOut === undefined) {
      baselineOut = outputTokens;
    }
    // Persist the self-seeded baselines back to the session map so a
    // later frame in the same turn doesn't re-seed against a fresh
    // initial value.
    lastTurnEndCumulativeBySession.set(cfg.sessionId, {
      inputTokens: baselineIn,
      outputTokens: baselineOut,
    });
    if (typeof inputTokens === "number") {
      snap.baselineInputTokens = baselineIn;
      snap.latestCumulativeInputTokens = inputTokens;
      // `baselineIn` is guaranteed defined when `inputTokens` is a
      // number because we seed it on the same frame.
      snap.tokensIn = Math.max(0, inputTokens - (baselineIn ?? 0));
    }
    if (typeof outputTokens === "number") {
      snap.baselineOutputTokens = baselineOut;
      snap.latestCumulativeOutputTokens = outputTokens;
      snap.tokensOut = Math.max(0, outputTokens - (baselineOut ?? 0));
    }
    if (snap.firstSeenAtMs === undefined) snap.firstSeenAtMs = nowMs();
    turnMetaByTurnId.set(event.turn_id, snap);
  }

  // -- (b) crew:message_meta ----------------------------------------------
  // Only emit if we have a model name AND at least one token count.
  // The legacy listener reads `model`, `tokens_in`, `tokens_out`,
  // `session_cost` — verify field-name mapping in
  // `session-context.tsx:720-735`.
  if (modelLabel && (inputTokens !== undefined || outputTokens !== undefined)) {
    dispatch(
      cfg,
      new CustomEvent("crew:message_meta", {
        detail: {
          sessionId: cfg.sessionId,
          topic: cfg.topic,
          turnId: event.turn_id,
          model: modelLabel,
          tokens_in: inputTokens,
          tokens_out: outputTokens,
          session_cost: sessionCost,
        },
      }),
    );
  }
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
  const offSpawnComplete = bridge.onSpawnComplete((e) =>
    handleSpawnComplete(cfg, e),
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
  const offToolStarted = bridge.onToolStarted((e) => handleToolStarted(cfg, e));
  const offToolProgress = bridge.onToolProgress((e) =>
    handleToolProgress(cfg, e),
  );
  const offToolCompleted = bridge.onToolCompleted((e) =>
    handleToolCompleted(cfg, e),
  );
  const offProgressUpdated = bridge.onProgressUpdated((e) =>
    handleProgressUpdated(cfg, e),
  );

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      offMessageDelta();
      offMessagePersisted();
      offSpawnComplete();
      offTaskUpdated();
      offTaskOutputDelta();
      offTurnLifecycle();
      offApprovalRequested();
      offToolStarted();
      offToolProgress();
      offToolCompleted();
      offProgressUpdated();
    },
  };
}
