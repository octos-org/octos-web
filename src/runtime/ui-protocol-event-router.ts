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
  QueueStateEvent,
  RouterFailoverEvent,
  RouterStatusEvent,
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
import * as TaskStore from "@/store/task-store";
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
  /** Last model string we saw. Primary source is
   *  `metadata.token_cost.model` (added server-side in PR
   *  `feat/cost-update-carry-model` —
   *  `crates/octos-cli/src/api/ui_protocol_progress.rs::map_cost_update`
   *  threads the field from `LlmProvider::provider_metadata_for_index`).
   *  Falls back to the legacy `metadata.label` carrier for daemons that
   *  haven't been upgraded yet. Optional — some turns don't carry a
   *  model. */
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

/** Last-seen task state + label per `task_id`. Mirrors the SSE-side
 *  `lastTaskStatusById` map in `runtime-provider.tsx` so a `task/updated`
 *  replay (e.g. on reconnect) doesn't inflate the in-bubble timeline.
 *  Tracking the rendered label too (codex round-3) lets a stream of
 *  `running` updates with refreshed `title`/`runtime_detail` through —
 *  pre-fix the state-only dedupe stuck spawn_only spinners on the
 *  very first label they emitted. */
interface LastTaskState {
  state: string;
  label?: string;
}
const lastTaskStateById = new Map<string, LastTaskState>();

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
 * server P1.3 fix in PR #767 added `media`; subsequent
 * "summary-missing-in-chat" fix in 2026-05-19 added optional `content`)
 * into the `MessageInfo` shape that `ThreadStore.appendPersistedMessage`
 * expects, for the late-artifact path (no live `pendingAssistant` to
 * promote).
 *
 * The row's `content` is now sourced from `event.content` when the
 * server carries it (non-empty captions / summaries accompanying a
 * `send_file` / mofa_slides / fm_tts delivery), and falls back to `""`
 * when omitted. Pre-fix the client hardcoded `""` here, which dropped
 * the assistant's caption on every media-bearing late artifact —
 * users saw the file in chat but not the text summary explaining it.
 *
 * Two ThreadStore merge behaviors are still honoured:
 *   - empty `content` + non-empty `media`: ThreadStore's media-only-merge
 *     predicate (`isMediaOnlyCompanion`, thread-store.ts:1706) treats
 *     this as a companion row and merges the file into the preceding
 *     assistant response — preserves the legacy file-only delivery UX.
 *   - non-empty `content` + non-empty `media`: NOT a media-only
 *     companion, so it lands as its own row with text + file rendered
 *     together — this is the new path that surfaces summaries.
 *   - text-only rows with no live pending fall through `appendPersistedMessage`
 *     and become text rows; `session/hydrate` may later replace them
 *     with canonical text but seq stays stable.
 */
function eventToMessageInfo(event: MessagePersistedEvent): MessageInfo {
  const media = event.media ?? [];
  // Use server-carried content when present so captions / summaries
  // alongside a file delivery reach the chat bubble. Fall back to ""
  // when omitted, which preserves the media-only-companion merge path
  // for legacy file-only deliveries.
  const content = event.content ?? "";
  return {
    role: event.role,
    content,
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
  // For live foreground turns the streamed `pendingAssistant.text`
  // (accumulated from `message/delta`) is the authoritative text source
  // and this event finalises the bubble. Since the 2026-05-19
  // "summary-missing-in-chat" fix the server now ALSO carries the
  // committed row's text on `event.content` (omitted when empty) so the
  // late-artifact path can surface captions / summaries that arrived
  // outside of a delta stream.
  //
  // Two cases:
  //
  //   (1) Match condition (assistant role + thread_id resolves to a
  //       thread with `pendingAssistant`): keep the streamed text
  //       (still authoritative for the live bubble), append each
  //       `media` URL to the pending bubble, then finalise with the
  //       event's `seq`. The downstream `turn/completed` no-ops
  //       because `pendingAssistant` is null after this.
  //
  //   (2) Unmatched (no pending — late artifact, non-assistant role,
  //       or assistant whose live pending was lost across reconnect):
  //       fall through to `appendPersistedMessage` so a fresh row
  //       appears in the thread. `event.content` (when present) is
  //       surfaced as the row's text; `event.media` lands as
  //       attachments — together they render as a text+file bubble
  //       (mofa_slides "Generated 12 slides..." + deck.pptx,
  //       fm_tts narration summary + audio, etc.).
  if (event.role === "assistant" && event.thread_id) {
    const promoted = tryPromotePendingFromPersisted(
      cfg.sessionId,
      cfg.topic,
      event,
    );
    if (promoted) return;
    // Phantom-bubble defence (production bug 2026-05-09; revised
    // 2026-05-19 once the server began carrying `content` on the wire):
    //
    // The original defence dropped ALL assistant persisted rows with
    // empty media that arrived without a pending to promote — built on
    // the UPCR-2026-012 invariant that text only travels via
    // `message/delta`, so a `message/persisted` arriving at an empty
    // thread was a bookkeeping artefact whose text was already in the
    // streamed bubble.
    //
    // Post-wire-content fix that invariant no longer holds: multi-iter
    // assistant rows (assistant → tool → assistant within one turn)
    // commit per-iteration with `content` populated. After the first
    // iter's persist promotes/finalises the pending, the streamed
    // pending is null, so subsequent iters' `message/delta` text is
    // dropped by `appendAssistantToken`'s `isFinalizedAndIdle` guard
    // — meaning iter-2+ text would be LOST if we kept dropping
    // empty-media rows here. The new rule: drop only when BOTH content
    // AND media are empty (true bookkeeping). A non-empty `content`
    // or non-empty `media` falls through to `appendPersistedMessage`,
    // whose seq-based dedupe (see `thread-store.ts:appendPersistedMessage`)
    // prevents duplicate rendering when the streamed bubble already
    // contained the text.
    const eventMedia = event.media ?? [];
    const eventContent = (event.content ?? "").trim();
    if (eventMedia.length === 0 && eventContent.length === 0) {
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
  // 2026-05-19 wire-content fix: when the streamed `message/delta`
  // raced/never-arrived and pending text is still empty, fall back to
  // `event.content` from the wire so the finalised bubble shows real
  // text instead of being empty. Streamed text remains authoritative
  // for non-empty pending (re-applying content would clobber partial
  // edits the user already saw on screen). This preserves the
  // Phase 5b empty-placeholder fix's intent — keep the bubble alive
  // until something renders — while shortcutting the "delta never
  // shows up" failure mode now that the wire carries text directly.
  const wireContent = (event.content ?? "").trim();
  if (
    thread.pendingAssistant.text.trim().length === 0 &&
    wireContent.length > 0
  ) {
    ThreadStore.appendAssistantToken(threadId, event.content ?? "");
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
  // `message/persisted` rows pair their files with the row's content
  // (text + file render together post-2026-05-19 wire-content fix);
  // any text was either already streamed via `message/delta` or just
  // appended above from `event.content`.
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

  // Bug 2026-05-15 (codex): flip the originating tool call's status to
  // `complete` BEFORE appending the new completion bubble. Pre-fix
  // `handleSpawnComplete` appended the bubble and dropped the
  // toolNameByCallId cache but never updated ThreadStore's tool-call
  // `status` field — so `addToolCall(..., status:"running")` left the
  // chip stuck at "running" forever after the background work finished.
  // Every spinner/icon gated on `toolCall.status === "running"`
  // (`ToolProgressIndicator`, `ToolCallBubble` per-tool icon,
  // streaming-dots placeholder) kept spinning.
  //
  // The `turn/spawn_complete` envelope is only emitted on SUCCESS (see
  // `TurnSpawnCompleteEvent` in `crates/octos-core/src/ui_protocol.rs`
  // — no `success` field); failures travel through `task/updated
  // state="failed"|"errored"` which `handleTaskUpdated` already maps
  // to `setToolCallStatus(..., "error")`. So this site is
  // unconditionally `"complete"`.
  //
  // Ordering matters: `setToolCallStatus` walks the host thread's
  // assistant slots via `pickAssistantSlot`, which returns the MOST
  // RECENT assistant response. If we appended the new completion
  // bubble first, that bubble would become the "most recent" slot —
  // and the tool call lives on the EARLIER ack bubble, so the lookup
  // would miss and the status flip would no-op. Run the status flip
  // first, while the ack bubble is still the topmost finalized slot.
  //
  // Locator strategy: resolve by the originating `tool_call_id` after
  // translating from the envelope's `task_id`.
  //
  // Bug 2026-05-15 (codex final-3 bonus check): the envelope's
  // `task_id` is the supervisor's `TaskId::new()` UUID (see
  // `crates/octos-agent/src/task_supervisor.rs::register_full`), NOT
  // the LLM's `tool_call_id`. The `BackgroundTask` struct keeps them
  // as separate fields, and `tool/started` registered the LLM's
  // `tool_call_id`. Passing `event.task_id` directly to ThreadStore's
  // by-tool-call-id lookup misses (different identifier shapes), and
  // the spinner stays stuck. We translate `task_id → tool_call_id`
  // through `TaskStore` (which the task watcher's
  // `crew:task_status` poll populates with `BackgroundTaskInfo`
  // rows carrying both `id` and `tool_call_id`). When the mapping is
  // not yet known (the task watcher hasn't polled, or the task is
  // brand new) fall back to treating `event.task_id` as the
  // tool_call_id — the older test fixtures used identical values
  // there and a fraction of legacy daemons still emit them equal.
  //
  // The previous defence (use `findThreadIdForToolCall` not
  // `setToolCallStatus(thread_id, ...)`) is still required: the
  // envelope's `turn_id` / `thread_id` may be a foreign id (codex
  // orphan-thread scenario in
  // `chat-thread-tool-failure-preserves-user-prompt.test`) that
  // does NOT contain the tool call — passing such an id to
  // `setToolCallStatus` would mint an empty-user orphan thread via
  // `ensureOrphanThread` and steal attribution from the user's real
  // prompt.
  //
  // Bug 2026-05-15 (codex round 2): the TaskStore lookup that
  // `resolveToolCallIdForTask` relies on races against the task watcher's
  // poll loop. In production the watcher only runs when the bridge's
  // `task/updated` envelope first dispatches `crew:bg_tasks` — but the
  // pre-fix bridge guard dropped EVERY `task/updated` (server emits no
  // `turn_id`), so the store stayed empty and the resolver fell back to
  // the raw supervisor UUID. The chip then never flipped. Prefer the
  // wire-borne `tool_call_id` (parallel server PR adds it) and use the
  // TaskStore lookup only as a fallback for legacy daemons.
  const resolvedToolCallId =
    event.tool_call_id ??
    resolveToolCallIdForTask(cfg.sessionId, cfg.topic, event.task_id);
  const statusHostThreadId = ThreadStore.findThreadIdForToolCall(
    cfg.sessionId,
    cfg.topic,
    resolvedToolCallId,
  );
  if (statusHostThreadId) {
    ThreadStore.setToolCallStatus(
      statusHostThreadId,
      resolvedToolCallId,
      "complete",
    );
  }

  // Belt-and-braces: clear the sidebar spinner at completion even if
  // the terminal `task/updated state="completed"` envelope is missed
  // (it already happens in practice — `turn/spawn_complete` is the
  // durable completion signal). Run unconditionally so the helper
  // works for tasks the running-state envelope was never delivered
  // for (e.g. reorder / replay where completion lands first).
  mergeLiveTask(
    cfg.sessionId,
    cfg.topic,
    event.task_id,
    resolvedToolCallId,
    "completed",
  );

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
  // Drop the cache entry — the BG task is done. The per-bubble
  // `ToolProgressIndicator` reads from ThreadStore (not window
  // events), so no terminal dispatch is needed here. Drop both
  // identifier shapes so the cache cannot leak through the
  // task_id-vs-tool_call_id divergence.
  toolNameByCallId.delete(event.task_id);
  if (resolvedToolCallId !== event.task_id) {
    toolNameByCallId.delete(resolvedToolCallId);
  }
}

export function handleTaskUpdated(
  cfg: RouterConfig,
  event: TaskUpdatedEvent,
): void {
  const previous = lastTaskStateById.get(event.task_id);
  // Dedupe ONLY when both state AND label are unchanged. The legacy
  // by-state-only dedupe meant a stream of `running` updates with
  // refreshed titles (e.g. "synthesising 1/3" → "synthesising 2/3")
  // was dropped — spawn_only progress would stay frozen on the
  // first label on the lifted spinner. Compare the rendered label
  // for running/spawned; terminal states don't carry one so the
  // state alone is enough.
  const stateUnchanged = previous?.state === event.state;
  const labelUnchanged =
    previous?.label === (event.title ?? event.runtime_detail);
  if (stateUnchanged && labelUnchanged) return;
  lastTaskStateById.set(event.task_id, {
    state: event.state,
    label: event.title ?? event.runtime_detail,
  });

  // For spawn_only background tools (podcast_generate / fm_tts /
  // deep_search / mofa_slides etc.) the running-state updates arrive
  // exclusively via `task/updated`, NOT `tool/progress` — the parent
  // LLM turn already settled at `turn/completed` before the
  // background work started. The lifted `ToolProgressIndicator`
  // therefore needs the spinner-progress fan-out here as well, with
  // the terminal flag set on the completion legs so the row clears.
  //
  // Bug 2026-05-15 (codex round 2): prefer the wire-borne
  // `event.tool_call_id` (parallel server PR adds it). Falls back to
  // the TaskStore `task_id → tool_call_id` lookup for legacy daemons,
  // which itself falls back to the raw `task_id` when the watcher
  // hasn't populated the store yet. The fallback chain handles all
  // three wire generations (modern carries tool_call_id, mid-tier has
  // separate task_id+tool_call_id with a watcher poll bridging them,
  // legacy emits them equal).
  const resolvedToolCallId =
    event.tool_call_id ??
    resolveToolCallIdForTask(cfg.sessionId, cfg.topic, event.task_id);

  // Bug 2026-05-15 (codex round 2): server-side `TaskUpdatedEvent`
  // carries NO `turn_id` — pre-fix bridge guard dropped every such
  // envelope. With the guard relaxed, `event.turn_id` is now
  // `undefined` in production. Route via `findThreadIdForToolCall`
  // (which scans every thread's pending + finalized assistant slots
  // for a tool call matching `resolvedToolCallId`) instead of trusting
  // `event.turn_id`. Falls back to a (likely-undefined) `event.turn_id`
  // only if no thread is found — `setToolCallStatus`/`appendToolProgress`
  // then no-op cleanly via the `ensureOrphanThread(undefined)` path
  // (`findThreadById(undefined)` returns null, and pickHostSessionForOrphan
  // would mint a placeholder thread but with no matching tool call it
  // exits without mutation).
  const hostThreadId =
    ThreadStore.findThreadIdForToolCall(
      cfg.sessionId,
      cfg.topic,
      resolvedToolCallId,
    ) ?? event.turn_id;

  // The `tool_name` lookup falls back to the task_id when no preceding
  // `tool/started` cached a name (e.g. a server-side flow that skips
  // `tool/started` entirely and only emits `task/updated`); same shape
  // `handleToolProgress` uses on the synchronous path. Try both the
  // resolved tool_call_id and the raw task_id so we hit the cache
  // whichever shape `tool/started` populated.
  const toolLabel =
    toolNameByCallId.get(resolvedToolCallId) ??
    toolNameByCallId.get(event.task_id) ??
    event.task_id;

  // Hydrate TaskStore directly from the live envelope so the sidebar
  // session-row spinner (`useAllTasksBySession()` in `chat-thread.tsx`)
  // lights within ms instead of waiting on the 2.5 s task-watcher poll
  // — which is currently broken upstream by a server-side session_key
  // filter mismatch (see `task_supervisor.rs:1753-1758`: the WS-side
  // `snapshot_excluding` path clears the supervisor's session_key, so
  // `/api/sessions/.../tasks` returns `[]` for the very tasks the
  // running session has). The poll path remains intact as redundant
  // safety net once the server bug is fixed.
  mergeLiveTask(
    cfg.sessionId,
    cfg.topic,
    event.task_id,
    resolvedToolCallId,
    event.state,
    event.title,
    event.runtime_detail,
  );

  switch (event.state) {
    case "spawned":
    case "running": {
      const label = event.title ?? event.runtime_detail ?? event.state;
      if (hostThreadId) {
        ThreadStore.appendToolProgress(hostThreadId, resolvedToolCallId, label);
      }
      // Mirror the legacy SSE bridge's `crew:bg_tasks` dispatch so any
      // listener that gates a session-level "background work" indicator
      // off the same event keeps firing.
      dispatch(
        cfg,
        new CustomEvent("crew:bg_tasks", {
          detail: { sessionId: cfg.sessionId, topic: cfg.topic },
        }),
      );
      // Light / refresh the spinner with the latest task state label.
      dispatchToolProgressEvent(cfg, hostThreadId, toolLabel, label);
      break;
    }
    case "completed": {
      if (hostThreadId) {
        ThreadStore.setToolCallStatus(
          hostThreadId,
          resolvedToolCallId,
          "complete",
        );
      }
      dispatchToolProgressEvent(
        cfg,
        hostThreadId,
        toolLabel,
        "done",
        /* terminal */ true,
      );
      // Drop the cache entry — the task is done, no further frames
      // should land on this id (mirrors `handleToolCompleted`). Drop
      // both identifier shapes.
      toolNameByCallId.delete(event.task_id);
      if (resolvedToolCallId !== event.task_id) {
        toolNameByCallId.delete(resolvedToolCallId);
      }
      break;
    }
    case "failed":
    case "errored": {
      if (hostThreadId) {
        ThreadStore.setToolCallStatus(
          hostThreadId,
          resolvedToolCallId,
          "error",
        );
      }
      dispatchToolProgressEvent(
        cfg,
        hostThreadId,
        toolLabel,
        "error",
        /* terminal */ true,
      );
      toolNameByCallId.delete(event.task_id);
      if (resolvedToolCallId !== event.task_id) {
        toolNameByCallId.delete(resolvedToolCallId);
      }
      break;
    }
    default:
      break;
  }
}

/** Map a server-emitted `task_id` (supervisor UUID) to the LLM
 *  `tool_call_id` the ThreadStore registered via `tool/started`.
 *
 *  Codex final-3 bonus check: the server's `TurnSpawnCompleteEvent.task_id`
 *  and `TaskUpdatedEvent.task_id` carry the supervisor's
 *  `TaskId::new()` UUID, while `ToolStartedEvent.tool_call_id` carries
 *  the LLM-emitted tool call id. They are different on the wire. The
 *  task watcher's `crew:task_status` poll populates `TaskStore` with
 *  `BackgroundTaskInfo` rows that carry BOTH fields, so we can
 *  translate by walking the session's tasks for a matching `id`.
 *
 *  Falls back to the raw `taskId` when:
 *  - the watcher hasn't polled yet (task list empty),
 *  - the task is brand new and not yet in the store,
 *  - a legacy daemon emits them equal (older tests / fixtures).
 *
 *  Returning the raw id is safe — `findThreadIdForToolCall` /
 *  `setToolCallStatus` no-op cleanly when the lookup misses. */
function resolveToolCallIdForTask(
  sessionId: string,
  topic: string | undefined,
  taskId: string,
): string {
  if (!taskId) return taskId;
  const tasks = TaskStore.getTasks(sessionId, topic);
  for (const task of tasks) {
    if (task.id === taskId && task.tool_call_id) {
      return task.tool_call_id;
    }
  }
  return taskId;
}

/** Hydrate TaskStore from a live `task/updated` (or terminal
 *  `turn/spawn_complete`) envelope so the sidebar session-row spinner
 *  (gated on `useAllTasksBySession()` reporting at least one
 *  `spawned`/`running` task) fires immediately — no dependency on the
 *  2.5 s task-watcher poll, which is currently broken upstream by a
 *  server-side `session_key` filter mismatch in `task_supervisor.rs`
 *  (the WS-side `snapshot_excluding` path clears the supervisor's
 *  session_key, so `/api/sessions/.../tasks` returns `[]` for the very
 *  tasks the running session has).
 *
 *  The watcher poll path is left intact upstream as a redundant safety
 *  net once the server bug is fixed; this hydration is the primary
 *  source of truth for the sidebar today.
 *
 *  Unknown / un-mappable states are ignored (no row written), so a
 *  forward-compat server adding a new state cannot pollute the store
 *  with `unknown`-status rows. */
function mergeLiveTask(
  sessionId: string,
  topic: string | undefined,
  taskId: string,
  toolCallId: string,
  state: string | undefined,
  title?: string,
  runtimeDetail?: string,
): void {
  const status =
    state === "spawned" || state === "pending"
      ? "spawned"
      : state === "running"
        ? "running"
        : state === "completed"
          ? "completed"
          : state === "failed" || state === "errored"
            ? "failed"
            : null;
  if (!status) return;

  const existing = TaskStore.getTasks(sessionId, topic).find(
    (t) => t.id === taskId,
  );
  const nowIso = new Date().toISOString();

  TaskStore.mergeTask(
    sessionId,
    {
      id: taskId,
      tool_name: title ?? existing?.tool_name ?? "Background task",
      tool_call_id: toolCallId || existing?.tool_call_id,
      status,
      started_at: existing?.started_at ?? nowIso,
      completed_at:
        status === "completed" || status === "failed" ? nowIso : null,
      output_files: existing?.output_files ?? [],
      error: status === "failed" ? (runtimeDetail ?? null) : null,
      session_key: sessionId,
    },
    topic,
  );
}

export function handleTaskOutputDelta(
  cfg: RouterConfig,
  event: TaskOutputDeltaEvent,
): void {
  if (!event.chunk) return;
  // Codex round 2 wire alignment: prefer wire-borne `tool_call_id`,
  // fall back to TaskStore mapping for legacy daemons. Route via
  // `findThreadIdForToolCall` since `event.turn_id` is now optional
  // (server-side struct doesn't carry it).
  const resolvedToolCallId =
    event.tool_call_id ??
    resolveToolCallIdForTask(cfg.sessionId, cfg.topic, event.task_id);
  const hostThreadId =
    ThreadStore.findThreadIdForToolCall(
      cfg.sessionId,
      cfg.topic,
      resolvedToolCallId,
    ) ?? event.turn_id;
  // Surface live tool stdout into the bubble's progress timeline. Dedupe
  // logic lives in ThreadStore.appendToolProgress (consecutive duplicates
  // are dropped) so resending the same chunk on reconnect is safe.
  if (hostThreadId) {
    ThreadStore.appendToolProgress(
      hostThreadId,
      resolvedToolCallId,
      event.chunk,
    );
  }
  // Codex round-3: also fan out to the lifted spinner. Some spawn_only
  // flows emit their real progress as output chunks, not `task/updated`
  // running labels; without this dispatch the spinner text goes stale
  // mid-task. Non-terminal — completion is signalled by `task/updated`
  // completed/failed/errored.
  const toolLabel =
    toolNameByCallId.get(resolvedToolCallId) ??
    toolNameByCallId.get(event.task_id) ??
    event.task_id;
  dispatchToolProgressEvent(cfg, hostThreadId, toolLabel, event.chunk);
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
// Handlers below feed the ThreadStore (via `addToolCall`,
// `appendToolProgress`, `setToolCallStatus`) AND dispatch
// `crew:tool_progress` window events for any external listeners. The
// `ToolProgressIndicator` component (2026-05-14 redesign,
// `src/components/tool-progress-indicator.tsx`) is now a pure
// derivation of the bubble's `message.toolCalls` — no longer a
// listener — so the window events here serve compatibility callers
// (e.g. external automation hooks) and are dead code at the
// indicator level. Removing the dispatches is a separate cleanup
// (no risk: the indicator is data-driven).

function dispatchToolProgressEvent(
  cfg: RouterConfig,
  turnId: string | undefined,
  toolName: string,
  message: string,
  /** When true, the `ToolProgressIndicator` clears the spinner row.
   *  Set on `tool/completed` (sync and spawn_only paths) because for
   *  spawn_only tools the LLM `crew:thinking false` has already fired
   *  at `turn/completed` BEFORE the background task starts emitting,
   *  so it can no longer be relied upon to clear the row. Without an
   *  explicit terminal signal the spinner would display the
   *  "done"/"error"/"complete" message indefinitely. */
  terminal: boolean = false,
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
        ...(terminal ? { terminal: true } : {}),
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
  // Mark terminal so the lifted `ToolProgressIndicator` clears the
  // spinner row. The bubble's `ToolCallBubble` reads the final
  // status from `ThreadStore.setToolCallStatus` above and keeps the
  // history-pill state intact — only the transient spinner row goes
  // away. Critical for spawn_only flows where `crew:thinking false`
  // already fired at `turn/completed` and cannot clean up.
  dispatchToolProgressEvent(
    cfg,
    event.turn_id,
    event.tool_name,
    message,
    /* terminal */ true,
  );
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
  // Server PR `feat/cost-update-carry-model` adds an authoritative
  // `metadata.token_cost.model` field, populated from
  // `LlmProvider::provider_metadata_for_index(...).model` so failover /
  // routed responses surface the model that actually answered. Prefer
  // that field; fall back to the legacy `metadata.label` carrier so
  // older daemons (the field is opt-in additive) continue to work.
  const costModel =
    typeof cost?.model === "string" && cost.model.length > 0
      ? cost.model
      : undefined;
  const labelModel =
    typeof event.metadata.label === "string" && event.metadata.label.length > 0
      ? event.metadata.label
      : undefined;
  const modelLabel = costModel ?? labelModel;

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
// Wave4-A: router/status, router/failover, queue/state
// ---------------------------------------------------------------------------
//
// Server PR #946 added three new notifications so the SPA can render the
// adaptive routing pill / failover banner / queue-depth indicator without
// polling. We fan each out into a `crew:*` DOM event so existing listeners
// (the dormant `crew:mode_update` subscriber in `useModeState()` plus the
// dead `queueMode` pill at `chat-thread.tsx:1642`) finally light up.
//
//   - `router/status`   → `crew:mode_update`  ({ adaptiveMode, providerName,
//                          qosRanking, laneScores, circuitBreakers })
//   - `router/failover` → `crew:router_failover` ({ from, to, reason,
//                          elapsedMs }) — chat-layout pops a 4 s banner.
//   - `queue/state`     → `crew:queue_state` ({ pendingCount, head })
//                          — also dispatched by the client-side FIFO in
//                          `ui-protocol-send.ts`, this branch covers a
//                          future server emission.

/**
 * Normalize the `router/status` adaptive mode wire value (`"off"` |
 * `"hedge"` | `"lane"`) into the `AdaptiveMode` shape `useModeState()`
 * expects. Unknown values map back to `null` so a server-side schema
 * extension doesn't render a stale pill.
 */
function normalizeAdaptiveMode(mode: string): "off" | "hedge" | "lane" | null {
  if (mode === "off" || mode === "hedge" || mode === "lane") return mode;
  return null;
}

export function handleRouterStatus(
  cfg: RouterConfig,
  event: RouterStatusEvent,
): void {
  // `crew:mode_update` shape was historically `{ queueMode?, adaptiveMode? }`
  // — the listener in `useModeState()` switches on each independently
  // (see `session-context.tsx:131-138`). The router-status path drives
  // the adaptive leg; queue depth flows via `crew:queue_state` below.
  // We additionally surface provider / score / breaker context so the
  // future routing-pill detail view can render a tooltip without an
  // extra round-trip.
  dispatch(
    cfg,
    new CustomEvent("crew:mode_update", {
      detail: {
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        adaptiveMode: normalizeAdaptiveMode(event.mode),
        providerName: event.provider_name,
        qosRanking: event.qos_ranking,
        laneScores: event.lane_scores,
        circuitBreakers: event.circuit_breakers,
      },
    }),
  );
}

export function handleRouterFailover(
  cfg: RouterConfig,
  event: RouterFailoverEvent,
): void {
  // Pop a transient banner. The chat-layout listens for this event and
  // renders a 4 s auto-dismiss notice describing the lane change. Field
  // names follow the existing camelCase DOM-event convention used by
  // `crew:tool_progress`, `crew:cost`, etc.
  dispatch(
    cfg,
    new CustomEvent("crew:router_failover", {
      detail: {
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        from: event.from_provider,
        to: event.to_provider,
        reason: event.reason,
        elapsedMs: event.elapsed_ms,
      },
    }),
  );
}

export function handleQueueState(
  cfg: RouterConfig,
  event: QueueStateEvent,
): void {
  // `ui-protocol-send.ts` dispatches the same shape directly because the
  // queue is client-side today (server PR #946 leaves the variant
  // unemitted). The bridge-routed branch covers a future server-side
  // emission and keeps the schema unified.
  dispatch(
    cfg,
    new CustomEvent("crew:queue_state", {
      detail: {
        sessionId: cfg.sessionId,
        topic: cfg.topic,
        pendingCount: event.pending_count,
        head: event.head_client_message_id,
      },
    }),
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
  // Wave4-A: adaptive router + queue depth surfaces. Three independent
  // subscriptions so each one's detach is local; the chat-layout's
  // banner listener and `useModeState()`'s pill listener consume the
  // dispatched DOM events directly.
  const offRouterStatus = bridge.onRouterStatus((e) =>
    handleRouterStatus(cfg, e),
  );
  const offRouterFailover = bridge.onRouterFailover((e) =>
    handleRouterFailover(cfg, e),
  );
  const offQueueState = bridge.onQueueState((e) => handleQueueState(cfg, e));

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
      offRouterStatus();
      offRouterFailover();
      offQueueState();
    },
  };
}
