/**
 * UI Protocol v1 typed event/result shapes used by the strict client bridge.
 *
 * Required fields are non-optional `string` — runtime guards in the bridge
 * reject events missing them and emit a `warning` rather than synthesizing
 * defaults. This is the fail-closed property called out in PR #63 review.
 */

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export type ApprovalDecision = "approve" | "deny";

export type ApprovalScope = "request" | "turn" | "session";

export interface UiCursor {
  stream: string;
  seq: number;
}

export interface TurnStartInput {
  kind: "text";
  text: string;
}

/**
 * UPCR-2026-015 (M9-β-1): wire-form file reference carried on
 * `TurnStartParams.media`. Mirrors the Rust `FileRef` reused from
 * UPCR-2026-014 (γ-1) — `path` is the durable filesystem handle
 * returned from `POST /api/upload`; `mime` and `size_bytes` are
 * captured at upload time. The web client populates all three.
 *
 * Note: the projection-side `FileRef` (lower in this file) leaves
 * `mime` and `size_bytes` optional to tolerate envelopes the server
 * emits with bare paths. The send-side shape here keeps them required
 * because the upload endpoint always returns them.
 */
export interface TurnStartMediaRef {
  path: string;
  mime: string;
  size_bytes: number;
}

/**
 * UPCR-2026-015 (M9-β-1): the full `turn/start` params envelope the
 * bridge serialises onto the wire. Strict-additive on top of the legacy
 * `{ session_id, turn_id, input }` shape — every new field is optional
 * and serialised only when populated.
 *
 * Mirrors the Rust `TurnStartParams` struct in
 * `crates/octos-core/src/ui_protocol.rs`. Keep these in lockstep —
 * `tsc --noEmit` is the only structural check; a drift between the
 * two is a wire bug.
 */
export interface TurnStartExtras {
  /** Pre-uploaded media references the user attached. Empty / omitted
   *  for text-only sends. */
  media?: TurnStartMediaRef[];
  /** Sub-topic suffix that scopes this send to a per-topic session
   *  bucket (`<session>#<topic>` form). Server folds it into the
   *  resolved `SessionKey` before scope validation. */
  topic?: string;
  /** When set, this turn rewrites an existing queued user message
   *  identified by its `client_message_id` (the `/queue` slash-command
   *  flow). β-1 server logs the field; durable in-place ledger
   *  replace lands in a follow-up. */
  rewrite_for?: string;
}

export interface SessionOpenedResult {
  session_id: string;
  active_profile_id?: string;
  cursor?: UiCursor;
  workspace_root?: string;
  panes?: unknown;
}

export interface SessionOpenResult {
  opened: SessionOpenedResult;
}

export interface TurnStartResult {
  accepted: boolean;
}

export interface TurnInterruptResult {
  interrupted: boolean;
}

export interface ApprovalRespondResult {
  approval_id: string;
  accepted: boolean;
  status: string;
  runtime_resumed?: boolean;
}

/**
 * `message/delta` notification per UI Protocol v1 spec § 6 / § 9.
 *
 * The wire payload's text-bearing field is named `text` to match
 * `octos_core::ui_protocol::MessageDeltaEvent` (see
 * `crates/octos-core/src/ui_protocol.rs`). An earlier version of this
 * type called the field `delta`; the guard then required `params.delta:
 * string` and silently rejected every real server frame, which left the
 * spawn-ack `pendingAssistant` empty (the M10 Phase 6.2 root cause —
 * empty-timestamp ghost bubble in the SPA). Keep this struct in lockstep
 * with the server enum or the bridge will fail closed without a visible
 * error.
 */
export interface MessageDeltaEvent {
  session_id: string;
  turn_id: string;
  text: string;
  message_id?: string;
}

export interface PersistedMessageFile {
  path: string;
  size?: number;
  mime?: string;
}

export interface PersistedMessage {
  id: string;
  thread_id: string;
  role: "assistant" | "user" | "tool";
  content: string;
  files?: PersistedMessageFile[];
  history_seq?: number;
  intra_thread_seq?: number;
  client_message_id?: string;
  response_to_client_message_id?: string;
  source_tool_call_id?: string;
  tool_calls?: Array<unknown>;
  timestamp?: string;
}

/**
 * `message/persisted` notification per `UPCR-2026-012`. Server emits a
 * flat metadata-only payload — content travels via `message/delta`, this
 * notification confirms the durable commit and (since the server's P1.3
 * fix in PR #767) carries the persisted row's `media` attachments so
 * the client can render them as `<a href>` in the chat bubble.
 *
 * IMPORTANT: this struct is the on-the-wire shape. The earlier nested
 * `{ message: { id, thread_id, content, role, files? } }` shape this
 * project once expected was speculative and never matched a real server
 * payload. Do NOT read `event.message.content` here — there is no
 * `content` field on the wire. The pending bubble's already-streamed
 * text is authoritative; this event finalises the bubble and adds
 * media URLs.
 */
export interface MessagePersistedEvent {
  session_id: string;
  /** Optional per UPCR-2026-012; absent on legacy rows that pre-date the
   *  typed-binding refactor. */
  turn_id?: string;
  /** Optional per UPCR-2026-012; same enforcement story as `turn_id`. */
  thread_id?: string;
  /** Strictly monotonic per session — assigned by `add_message_with_seq`. */
  seq: number;
  /** Open snake_case enum, matching `octos-core::MessageRole`. */
  role: "system" | "user" | "assistant" | "tool";
  /** Server-assigned UUID for the row. Stable across replays. */
  message_id: string;
  /** Present for `source = user` rows where the client supplied a cmid;
   *  absent on legacy rows. */
  client_message_id?: string;
  /** Open snake_case enum identifying the WRITE PATH that committed the row. */
  source: "user" | "assistant" | "tool" | "background" | "recovery";
  /** Durable cursor pointing at this commit. */
  cursor: { stream: string; seq: number };
  /** RFC 3339 wall-clock time the row was committed. */
  persisted_at: string;
  /** File attachments persisted with this row — typically a single
   *  `.md` / `.mp3` / `.pptx` artefact emitted by `spawn_only` background
   *  tools (`deep_search`, `mofa_*`, `fm_tts`) or an explicit
   *  `send_file` call. Absent or empty for ordinary text rows. */
  media?: string[];
}

/**
 * `turn/spawn_complete` notification per M10 Phase 1 (server PR #772).
 *
 * Emitted by the server when a `spawn_only` background tool finishes. Each
 * envelope is structurally complete on arrival — the client renders it as a
 * NEW assistant bubble under the originating user prompt rather than
 * splice-merging late content into an existing bubble (the bug class M10
 * eliminates: sticky-map drift, phantom-chunk drop, etc.).
 *
 * Capability gated: server only emits when the client has negotiated
 * `event.spawn_complete.v1` at session/open. Older clients without the
 * capability continue to receive the legacy `message/persisted` row for
 * backward compatibility.
 *
 * Wire shape mirrors `MessagePersistedEvent` with two distinguishing
 * additions:
 *   - `task_id` is REQUIRED (every spawn_complete has an originating
 *     `spawn_only` task; a row without one is a server bug).
 *   - `content` is REQUIRED (carries the full assistant text inline so the
 *     client renders the new bubble atomically without a follow-up fetch).
 *     This is what distinguishes the envelope from a spawn-ack persisted
 *     row, whose content is a short ack message.
 *
 * Note on `response_to_client_message_id`: Phase 1 server populates this
 * from the same identifier that `message/persisted.thread_id` carries on
 * the same persisted row. Phase 4 will introduce a typed
 * `originating_client_message_id` to remove the semantic ambiguity. Until
 * then, the SPA reducer keys placement off `thread_id` (server-carried
 * since PR #680) and treats `response_to_client_message_id` as advisory.
 */
export interface TurnSpawnCompleteEvent {
  session_id: string;
  /** Optional per server-side schema; `None` from `run_standalone_turn`
   *  until Phase 4 plumbing surfaces a real turn id. */
  turn_id?: string;
  /** Optional per server-side schema; absent on legacy callers. */
  thread_id?: string;
  /** Always populated. Identifies the originating `spawn_only` task —
   *  used by Phase 4's `read_task_output` flow. */
  task_id: string;
  /** Optional in Phase 1 (server emits a thread-id-flavoured value); used
   *  as advisory placement only. Phase 4 will populate this with the real
   *  user-prompt cmid. */
  response_to_client_message_id?: string;
  /** Per-session committed-row index (matches `MessagePersistedEvent.seq`
   *  for the same row). Strictly monotonic. */
  seq: number;
  /** Server-assigned message id reused from the persisted row (since
   *  Phase 1 codex round 3 fix). Stable across replays. */
  message_id: string;
  /** Source of the completion. Always `"background"` today; reserved as
   *  string so future variants (`"recovery_background"`, etc.) extend the
   *  vocabulary without a wire-breaking change. */
  source: string;
  /** Durable cursor pointing at this commit in the UI ledger. */
  cursor: UiCursor;
  /** RFC 3339 wall-clock time the row was committed. */
  persisted_at: string;
  /** REQUIRED. Full assistant text for the completion bubble. Distinct
   *  from `MessagePersistedEvent` (where `content` lives only in the
   *  session ledger), this event carries the text inline. */
  content: string;
  /** File attachments persisted with this completion (e.g.
   *  `_report.md`, `output.mp3`, `.pptx`). Same convention as
   *  `MessagePersistedEvent.media`. */
  media?: string[];
}

export interface TaskUpdatedEvent {
  session_id: string;
  turn_id: string;
  task_id: string;
  state: string;
  title?: string;
  runtime_detail?: string;
  output_tail?: string;
}

export interface TaskOutputDeltaEvent {
  session_id: string;
  turn_id: string;
  task_id: string;
  chunk: string;
  cursor?: { offset: number };
}

export interface TurnStartedEvent {
  session_id: string;
  turn_id: string;
}

export interface TurnCompletedEvent {
  session_id: string;
  turn_id: string;
  reason?: string;
}

export interface TurnErrorEvent {
  session_id: string;
  turn_id: string;
  error: { code: number; message: string; data?: unknown };
}

/**
 * `tool/started` notification per UI Protocol v1 spec. Server emits this when
 * the agent begins executing a synchronous (non-spawn) tool call. Wire shape
 * mirrors `octos_core::ui_protocol::ToolStartedEvent` —
 * `session_id`, `turn_id`, `tool_call_id`, `tool_name` are required;
 * `arguments` is optional.
 *
 * The web client lifts this onto the legacy `crew:tool_progress` DOM event
 * (the spinner under the streaming assistant bubble) so the
 * `ToolProgressIndicator` component lights up the moment a tool starts —
 * the SSE bridge predecessor of this surface was the sole dispatcher prior
 * to PR #96, and the new event-router restores parity.
 */
export interface ToolStartedEvent {
  session_id: string;
  turn_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments?: unknown;
}

/**
 * `tool/progress` notification — mid-execution status frames a tool emits
 * while it runs. Mirrors `octos_core::ui_protocol::ToolProgressEvent`.
 * `message` and `progress_pct` are both optional on the wire (server emits
 * whichever is meaningful for the tool surface).
 */
export interface ToolProgressEvent {
  session_id: string;
  turn_id: string;
  tool_call_id: string;
  message?: string;
  progress_pct?: number;
}

/**
 * `tool/completed` notification — terminal status frame for a synchronous
 * tool call. Mirrors `octos_core::ui_protocol::ToolCompletedEvent`.
 * `success`, `output_preview`, and `duration_ms` are all optional on the
 * wire (server emits whichever is meaningful for the tool surface).
 */
export interface ToolCompletedEvent {
  session_id: string;
  turn_id: string;
  tool_call_id: string;
  tool_name: string;
  success?: boolean;
  output_preview?: string;
  duration_ms?: number;
}

/**
 * Token / cost counters carried on `progress/updated` notifications whose
 * `metadata.kind === "token_cost_update"`. Mirrors
 * `octos_core::ui_protocol::UiTokenCostUpdate`. All fields are optional on
 * the wire — the server populates whichever counters changed for the
 * frame.
 */
export interface UiTokenCostUpdate {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  response_cost?: number;
  session_cost?: number;
  currency?: string;
}

/**
 * Retry / backoff counters carried on `progress/updated` notifications
 * whose `metadata.kind === "retry_backoff"`. Mirrors
 * `octos_core::ui_protocol::UiRetryBackoff`. All fields are optional on
 * the wire.
 */
export interface UiRetryBackoff {
  attempt?: number;
  max_attempts?: number;
  backoff_ms?: number;
  reason?: string;
  provider?: string;
  next_provider?: string;
}

/**
 * File-mutation notice carried on `progress/updated` notifications whose
 * `metadata.kind === "file_mutation"`. Mirrors
 * `octos_core::ui_protocol::UiFileMutationNotice`. `path` and `operation`
 * are required; the rest are optional.
 */
export interface UiFileMutationNotice {
  path: string;
  operation: string;
  tool_call_id?: string;
  bytes_written?: number;
}

/**
 * Metadata envelope on `progress/updated` notifications. Mirrors
 * `octos_core::ui_protocol::UiProgressMetadata`. The wire shape carries an
 * open `kind` discriminator plus per-kind structured payloads; legacy
 * `extra` fields are passed through via the `[key: string]: unknown`
 * index signature so future server-side extensions don't trip the
 * fail-closed reject path.
 */
export interface UiProgressMetadata {
  kind: string;
  label?: string;
  message?: string;
  detail?: string;
  iteration?: number;
  progress_pct?: number;
  retry?: UiRetryBackoff;
  file_mutation?: UiFileMutationNotice;
  token_cost?: UiTokenCostUpdate;
  [extra: string]: unknown;
}

/**
 * `progress/updated` notification — the canonical UI Protocol v1 channel
 * for non-message-stream progress signals (cost telemetry, status pings,
 * retry/backoff frames, file-mutation notices, ...). Mirrors
 * `octos_core::ui_protocol::UiProgressEvent` /
 * `ProgressUpdatedEvent`. `session_id` is required; `turn_id` is optional
 * because some progress kinds (e.g. session-scoped status) emit outside a
 * turn context.
 *
 * The web client lifts this onto two legacy DOM events: `crew:cost`
 * (header model + token / cost badge) and, when model + duration are
 * available, `crew:message_meta` (assistant bubble footer model + tokens
 * + duration). The SSE bridge predecessor of this surface was the sole
 * dispatcher prior to PR #96.
 */
export interface ProgressUpdatedEvent {
  session_id: string;
  turn_id?: string;
  metadata: UiProgressMetadata;
}

export interface ApprovalRenderHints {
  default_decision?: ApprovalDecision;
  primary_label?: string;
  secondary_label?: string;
  danger?: boolean;
  monospace_fields?: string[];
}

export interface ApprovalTypedDetails {
  kind?: string;
  [field: string]: unknown;
}

export interface ApprovalRequestedEvent {
  session_id: string;
  approval_id: string;
  turn_id: string;
  tool_name: string;
  title: string;
  body: string;
  approval_kind?: string;
  approval_scope?: ApprovalScope;
  risk?: string;
  typed_details?: ApprovalTypedDetails;
  render_hints?: ApprovalRenderHints;
}

export interface WarningEvent {
  reason: string;
  context?: unknown;
}

/**
 * Wave4-A `router/status` notification — adaptive routing snapshot
 * pushed alongside `turn/started` and `turn/completed` so clients can
 * render the routing pill / lane debug view without polling. Mirrors
 * `octos_core::ui_protocol::RouterStatusEvent` (server PR #946).
 *
 * `lane_scores` keys are `"<provider_name>/<model_id>"`. `circuit_breakers`
 * carries the same keys mapped to a string-rendered breaker state
 * (`"closed"`, `"open"`, `"half_open"`). Both wire as deterministic
 * `BTreeMap`s on the server side so re-renders stay diff-stable.
 */
export interface RouterStatusEvent {
  session_id: string;
  /** Currently selected provider, in `"<provider_name>/<model_id>"` form. */
  provider_name: string;
  /** Active adaptive mode (`"off"` | `"hedge"` | `"lane"`). */
  mode: string;
  /** QoS quality-ranking toggle (orthogonal to mode). */
  qos_ranking: boolean;
  /** Per-lane scores, keyed by `"<provider_name>/<model_id>"`. */
  lane_scores: Record<string, number>;
  /** Per-lane breaker state — `"closed"` / `"open"` / `"half_open"`. */
  circuit_breakers: Record<string, string>;
}

/**
 * Wave4-A `router/failover` notification — emitted when the adaptive
 * router crosses lanes. Mirrors `octos_core::ui_protocol::RouterFailoverEvent`.
 *
 * `from_provider` / `to_provider` use the same `"<provider_name>/<model_id>"`
 * key shape as `RouterStatusEvent.lane_scores`. `reason` is free-text
 * (e.g. `"circuit_breaker_open"`, `"score_drop"`). `elapsed_ms` is the
 * wall time from initial provider attempt to failover decision.
 */
export interface RouterFailoverEvent {
  session_id: string;
  from_provider: string;
  to_provider: string;
  reason: string;
  elapsed_ms: number;
}

/**
 * Wave4-A `queue/state` notification — pending-queue snapshot.
 * Client-emitted today (the queue lives in
 * `src/runtime/ui-protocol-send.ts`'s per-session FIFO). The server
 * never emits this variant — the web bridge manufactures it locally so
 * other clients can observe queue depth uniformly. Mirrors
 * `octos_core::ui_protocol::QueueStateEvent`.
 */
export interface QueueStateEvent {
  session_id: string;
  pending_count: number;
  /** Identifies the in-flight turn whose completion will release the
   *  next queued frame. `null` when the queue is empty. */
  head_client_message_id: string | null;
}

/**
 * Wave4-A `router/set_mode` params + result. Mirrors
 * `octos_core::ui_protocol::RouterSetModeParams` /
 * `RouterSetModeResult`. `mode` is the lowercase string rendering of
 * `octos_llm::AdaptiveMode` — `"off"`, `"hedge"`, or `"lane"`.
 */
export interface RouterSetModeParams {
  session_id: string;
  mode: string;
}

export interface RouterSetModeResult {
  /** New mode actually committed by the router. Echo of `params.mode`
   *  when the call succeeded. */
  mode: string;
}

/**
 * Wave4-A `router/get_metrics` result. Identical wire shape to
 * `RouterStatusEvent` minus the `session_id` echo. When no adaptive
 * router is attached to the session (single-provider profile), the
 * server returns an `invalid_params` RPC error whose
 * `data.kind === "runtime_unavailable"` — clients use that signal to
 * grey out the router-mode switcher.
 */
export interface RouterGetMetricsResult {
  provider_name: string;
  mode: string;
  qos_ranking: boolean;
  lane_scores: Record<string, number>;
  circuit_breakers: Record<string, string>;
}

/**
 * UPCR-2026-016 (M9-β-2) `session/closed` notification.
 *
 * Server emits this after a successful `session/delete` clears at
 * least one entry from the standalone session store. Web clients use
 * it to remove the row from the sidebar in real time so a delete
 * action on one tab reflects on every other open tab without polling.
 *
 * `reason` is a free-form discriminator; the canonical value today is
 * `"deleted"`. Future producers may emit `"expired"`, `"forked"`, etc.
 * Treat unknown values as opaque so a server upgrade does not break
 * the client.
 */
export interface SessionClosedEvent {
  session_id: string;
  reason?: string;
  timestamp?: string;
  cursor?: UiCursor;
}

/**
 * UPCR-2026-016 (M9-β-2) `session/title-updated` notification.
 *
 * Server emits this after a successful `session/title.set` call. Web
 * clients re-render the sidebar row in place — the auto-titler fires
 * the same JSON-RPC method from its caller, so this event covers both
 * manual rename and auto-naming flows the user perceives.
 *
 * `reason` is `"manual"` for direct user-driven renames today. Future
 * producers may emit `"auto"`, `"bulk_rename"`, etc.
 */
export interface SessionTitleUpdatedEvent {
  session_id: string;
  title: string;
  reason?: string;
  timestamp?: string;
  cursor?: UiCursor;
}

export interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * `session/hydrate` row shape per server PR #791 (M10 Phase 6.2 / Bug C).
 *
 * Mirrors `octos_core::ui_protocol::HydratedMessage`. The two fields the
 * SPA cares about for hydrate-time dedup of legacy `Background`-source
 * rows are:
 *
 *   - `message_id`: stable per-row identity, agrees with
 *     `MessagePersistedEvent.message_id` and
 *     `TurnSpawnCompleteEvent.message_id` for the same row. The server
 *     populates this only when the connection negotiated
 *     `event.spawn_complete.v1`.
 *   - `source`: snake_case wire form of `MessagePersistedSource`
 *     (`"user" | "assistant" | "tool" | "background" | "recovery"`).
 *     Used to identify the per-file `send_file` companion rows the live
 *     wire suppresses for negotiated clients.
 *
 * Both are `Option<String>` on the wire; legacy clients that pre-date
 * negotiation see them omitted (back-compat). Treat both as optional.
 */
export interface HydratedMessage {
  seq: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  turn_id?: string;
  thread_id?: string;
  client_message_id?: string;
  persisted_at: string;
  message_id?: string;
  source?: string;
  media?: string[];
}

/**
 * `session/hydrate` result shape per server PR #791. The `messages`
 * field is omitted when the request didn't include `"messages"`; the
 * `replayed_envelopes` field is omitted when the connection didn't
 * negotiate `event.spawn_complete.v1` OR `messages` wasn't requested.
 *
 * The negotiated dedup contract on a fresh page reload is:
 *
 *   1. For each `replayed_envelopes[i]`, find the row in `messages`
 *      whose `message_id` matches: that's the spawn-ack the live wire
 *      replaced with the envelope. Drop the row, render the envelope.
 *   2. For each Background companion row in the same thread that
 *      precedes the spawn-ack and does NOT match any envelope's
 *      `message_id`: drop it (the envelope's `media` already covers
 *      it).
 *   3. All other rows replay verbatim.
 */
export interface SessionHydrateResult {
  session_id: string;
  cursor: UiCursor;
  messages?: HydratedMessage[];
  threads?: unknown[];
  turns?: unknown[];
  pending_approvals?: unknown[];
  replayed_envelopes?: TurnSpawnCompleteEvent[];
}

// ─── M9-γ canonical projection envelope (UPCR-2026-014) ────────────────────
//
// Mirrors `crates/octos-core/src/ui_protocol.rs` (Rust enum uses
// `serde(tag = "type", content = "data", rename_all = "snake_case")`).
//
// Spec: `api/OCTOS_UI_PROTOCOL_V1_SPEC_2026-04-24.md` § 14
// "M9-γ Envelope".
// ADR: `docs/M9-GAMMA-SERVER-PROJECTION-ADR.md`.
//
// **Hard barrier**: per the ADR, `turn_completed` is the terminal
// payload for a `thread_id`. No further `assistant_*`/`tool_*`
// payloads on the same thread are valid after it.
//
// These types are sourced verbatim from γ-1 PR #848
// (`feat/m9-gamma-1-envelope-spec`). When that PR's web mirror lands
// upstream, this block becomes the import surface for the M9-γ-2
// projection function (`src/store/projection.ts`) and the M9-γ-3
// `ThreadStore` cutover.

/** Multi-turn cluster identity — the chat thread this envelope projects
 *  into. All envelopes for one logical conversation share a `thread_id`. */
export type ThreadId = string;

/** Server-assigned UUID of a durable message row. Stable across replays.
 *  Mirrors `MessageMeta.message_id` in the Rust types. */
export type EnvelopeMessageId = string;

/** Client optimism + idempotency token. Web client mints; UUIDv7 in prod.
 *  ONLY the optimistic <GhostBubble> overlay consults this — the
 *  projection itself never does. */
export type ClientMessageId = string;

/** RFC 3339 timestamp string (e.g. "2026-05-09T18:30:01Z"). */
export type IsoTimestamp = string;

/** Sub-typed numeric for the strict per-thread server ordering. */
export type Seq = number;

/** Token usage carried on `turn_completed` envelopes. Mirrors
 *  `EnvelopeTokenUsage` in the Rust types. All fields default to zero
 *  and are omitted on the wire when zero (serde
 *  `skip_serializing_if = "is_zero_u64"`). */
export interface EnvelopeTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** Metadata carried on `assistant_persisted` envelopes. Mirrors
 *  `MessageMeta` in the Rust types. */
export interface MessageMeta {
  /** Server-assigned UUID of the durable row. */
  message_id: EnvelopeMessageId;
  /** Wall-clock RFC 3339 commit time. */
  persisted_at: IsoTimestamp;
  /** File attachments persisted with the message — typically a single
   *  `.md` / `.mp3` / `.pptx` artefact. Empty for assistant rows that
   *  carry only text. Omitted on the wire when empty. */
  media?: string[];
}

/** Status carried on `tool_end` payloads. Mirrors `EnvelopeToolEndStatus`
 *  (snake_case wire form) in the Rust types. */
export type EnvelopeToolEndStatus = "complete" | "error";

/** File attachment carried on `user_message` envelopes. Mirrors `FileRef`
 *  in the Rust types (γ-1 PR #848 commit `ac589b73`). The `path` field
 *  is the durable filesystem path the server can resolve; `mime` and
 *  `size_bytes` are optional metadata captured at upload time. */
export interface FileRef {
  path: string;
  mime?: string;
  size_bytes?: number;
}

interface UserMessagePayload {
  type: "user_message";
  data: { text: string; files: FileRef[] };
}

interface AssistantDeltaPayload {
  type: "assistant_delta";
  data: { text: string };
}

interface AssistantPersistedPayload {
  type: "assistant_persisted";
  data: { text: string; meta: MessageMeta };
}

interface ToolStartPayload {
  type: "tool_start";
  data: { tool_call_id: string; name: string };
}

interface ToolProgressPayload {
  type: "tool_progress";
  data: { tool_call_id: string; message: string };
}

interface ToolEndPayload {
  type: "tool_end";
  data: {
    tool_call_id: string;
    status: EnvelopeToolEndStatus;
    /** Set iff `status === 'error'`. Omitted on the wire when null. */
    error?: string;
  };
}

interface FileAttachedPayload {
  type: "file_attached";
  data: { path: string; mime: string; size_bytes: number };
}

interface TurnCompletedPayload {
  type: "turn_completed";
  data: { token_usage: EnvelopeTokenUsage };
}

/** Sealed tagged union of payloads carried by the M9-γ projection
 *  envelope. The discriminator is `type`; payload data lives under
 *  `data`. Variant names are snake_case to match the wire / Rust shape. */
export type Payload =
  | UserMessagePayload
  | AssistantDeltaPayload
  | AssistantPersistedPayload
  | ToolStartPayload
  | ToolProgressPayload
  | ToolEndPayload
  | FileAttachedPayload
  | TurnCompletedPayload;

/** Canonical M9-γ projection envelope.
 *
 *  Per UPCR-2026-014 and the M9-γ ADR, this is the single shape the
 *  web client's deterministic projection consumes. The committed
 *  envelope log is `Envelope[]` indexed by `(thread_id, seq)`; the
 *  projection is a pure function from that log to `ChatViewModel`.
 *
 *  Identity collapses to `seq` — the only key the projection cares
 *  about. `client_message_id` lives ONLY on user-message-rooted
 *  envelopes so the optimistic `<GhostBubble>` overlay can match its
 *  server reflection and unmount; the projection itself NEVER consults
 *  it. */
export interface Envelope {
  thread_id: ThreadId;
  seq: Seq;
  /** Present on user-message-rooted envelopes (the optimistic
   *  `<GhostBubble>` overlay matches its server reflection here).
   *  Absent on internal events (assistant deltas, tool events,
   *  turn_completed). The projection MUST NOT consult this field. */
  client_message_id?: ClientMessageId;
  payload: Payload;
}

/** Wire-form capability flag for UPCR-2026-014. Servers advertise it via
 *  `UiProtocolCapabilities.supported_features`; clients request it via
 *  the `X-Octos-Ui-Features` header. Mirrors
 *  `UI_PROTOCOL_FEATURE_PROJECTION_ENVELOPE_V1` in the Rust types. */
export const UI_PROTOCOL_FEATURE_PROJECTION_ENVELOPE_V1 = "projection.envelope.v1";

// ── Type guards (optional ergonomic helpers) ─────────────────────────────
//
// The projection function will switch on `envelope.payload.type` and
// rely on TS's discriminated-union narrowing. These helpers exist for
// callers that need a runtime check (e.g. a debug overlay rendering a
// raw envelope).

export function isUserMessage(p: Payload): p is UserMessagePayload {
  return p.type === "user_message";
}

export function isAssistantDelta(p: Payload): p is AssistantDeltaPayload {
  return p.type === "assistant_delta";
}

export function isAssistantPersisted(p: Payload): p is AssistantPersistedPayload {
  return p.type === "assistant_persisted";
}

export function isToolStart(p: Payload): p is ToolStartPayload {
  return p.type === "tool_start";
}

export function isToolProgress(p: Payload): p is ToolProgressPayload {
  return p.type === "tool_progress";
}

export function isToolEnd(p: Payload): p is ToolEndPayload {
  return p.type === "tool_end";
}

export function isFileAttached(p: Payload): p is FileAttachedPayload {
  return p.type === "file_attached";
}

export function isTurnCompleted(p: Payload): p is TurnCompletedPayload {
  return p.type === "turn_completed";
}
