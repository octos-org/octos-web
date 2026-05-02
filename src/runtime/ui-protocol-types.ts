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

export interface MessageDeltaEvent {
  session_id: string;
  turn_id: string;
  delta: string;
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

export interface MessagePersistedEvent {
  session_id: string;
  turn_id: string;
  message: PersistedMessage;
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
