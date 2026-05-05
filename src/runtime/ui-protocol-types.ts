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

export interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}
