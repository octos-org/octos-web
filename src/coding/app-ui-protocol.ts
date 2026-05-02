import { getSelectedProfileId, getToken } from "@/api/client";

export const APP_UI_API_V1 = "octos-app-ui/v1alpha1";
export const UI_PROTOCOL_V1 = "octos-ui/v1alpha1";
export const JSON_RPC_VERSION = "2.0";
export const UI_FEATURES = ["approval.typed.v1", "pane.snapshots.v1"] as const;

export const UI_METHODS = {
  sessionOpen: "session/open",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  approvalRespond: "approval/respond",
  approvalRequested: "approval/requested",
  messageDelta: "message/delta",
  taskUpdated: "task/updated",
  taskOutputDelta: "task/output/delta",
  taskOutputRead: "task/output/read",
  diffPreviewGet: "diff/preview/get",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  turnError: "turn/error",
  warning: "warning",
} as const;

export type ApprovalDecision = "approve" | "deny";
export type ApprovalScope = "request" | "turn" | "session";
export type CodingConnectionState =
  | "connecting"
  | "connected"
  | "offline"
  | "error";

export interface RpcRequest<TParams = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  method: string;
  params: TParams;
}

export interface RpcNotification<TParams = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params: TParams;
}

export interface RpcResponse<TResult = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  result?: TResult;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface AppUiEvent {
  kind: "snapshot" | "protocol" | "progress" | "status" | "error";
  payload?: unknown;
}

export interface SessionOpenParams {
  session_id: string;
  profile_id?: string;
}

export interface TurnStartParams {
  session_id: string;
  turn_id: string;
  input: Array<{ kind: "text"; text: string }>;
}

export interface ApprovalRespondParams {
  session_id: string;
  approval_id: string;
  decision: ApprovalDecision;
  approval_scope?: ApprovalScope;
  client_note?: string;
}

export interface ApprovalTypedDetails {
  kind: string;
  command?: {
    command_line?: string;
    cwd?: string;
    argv?: string[];
  };
  diff?: {
    preview_id?: string;
    summary?: string;
    files?: Array<{ path?: string; status?: string }>;
  };
  filesystem?: {
    operation?: string;
    path?: string;
    paths?: string[];
  };
  network?: {
    host?: string;
    url?: string;
    method?: string;
  };
  sandbox_escalation?: {
    justification?: string;
    requested_permissions?: string[];
    suggested_prefix_rule?: string[];
  };
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
  render_hints?: {
    default_decision?: ApprovalDecision;
    primary_label?: string;
    secondary_label?: string;
    danger?: boolean;
    monospace_fields?: string[];
  };
}

export interface MessageDeltaEvent {
  session_id: string;
  turn_id?: string;
  delta?: string;
  text?: string;
  content?: string;
}

export interface TaskUpdatedEvent {
  session_id: string;
  task_id?: string;
  id?: string;
  title?: string;
  state?: string;
  runtime_detail?: string;
  output_tail?: string;
}

export interface TaskOutputDeltaEvent {
  session_id: string;
  task_id: string;
  chunk?: string;
  text?: string;
  output?: string;
  cursor?: { offset?: number };
}

export interface PaneSnapshot {
  workspace?: {
    root?: string;
    entries?: Array<{
      path?: string;
      kind?: string;
      detail?: string;
      status?: string;
    }>;
  };
  artifacts?: {
    items?: Array<{
      title?: string;
      path?: string;
      kind?: string;
      detail?: string;
    }>;
  };
  git?: {
    status?: Array<{ path?: string; status?: string }>;
    history?: Array<{ commit?: string; summary?: string }>;
  };
}

export interface DiffPreviewResult {
  status?: string;
  source?: string;
  preview?: {
    preview_id?: string;
    title?: string;
    files?: Array<{
      path?: string;
      old_path?: string;
      status?: string;
      hunks?: Array<{
        header?: string;
        lines?: Array<{
          kind?: "added" | "removed" | "context" | string;
          content?: string;
          old_line?: number;
          new_line?: number;
        }>;
      }>;
    }>;
  };
}

export interface TaskOutputReadResult {
  task_id?: string;
  output?: string;
  text?: string;
  cursor?: { offset?: number };
}

export function createRpcRequest<TParams>(
  method: string,
  params: TParams,
): RpcRequest<TParams> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: crypto.randomUUID(),
    method,
    params,
  };
}

export function createCodingSessionId(): string {
  const profileId = getSelectedProfileId();
  const chatId = `coding-${crypto.randomUUID()}`;
  return profileId ? `${profileId}:api:${chatId}` : `api:${chatId}`;
}

export function uiProtocolWebSocketUrl(): string {
  const baseUrl = new URL("/api/ui-protocol/ws", window.location.origin);
  const token = getToken();
  if (token) baseUrl.searchParams.set("token", token);
  UI_FEATURES.forEach((feature) => {
    baseUrl.searchParams.append("ui_feature", feature);
  });
  baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  return baseUrl.toString();
}

export function protocolNotificationFromEvent(
  detail: unknown,
): RpcNotification | null {
  if (!detail || typeof detail !== "object") return null;
  const maybeEvent = detail as AppUiEvent | RpcNotification;
  if ("kind" in maybeEvent && maybeEvent.kind === "protocol") {
    return protocolNotificationFromEvent(maybeEvent.payload);
  }
  if (
    "jsonrpc" in maybeEvent &&
    maybeEvent.jsonrpc === JSON_RPC_VERSION &&
    "method" in maybeEvent &&
    typeof maybeEvent.method === "string"
  ) {
    return maybeEvent as RpcNotification;
  }
  return null;
}
