// octos API types

export interface ChatRequest {
  message: string;
  session_id?: string;
  topic?: string;
  client_message_id?: string;
  media?: string[];
}

export interface ChatResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
}

export interface SessionInfo {
  id: string;
  message_count: number;
}

export interface MessageInfo {
  seq?: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  client_message_id?: string;
  response_to_client_message_id?: string;
  tool_call_id?: string;
  timestamp: string;
  media?: string[];
  tool_calls?: { id?: string; name?: string }[];
}

export interface BackgroundTaskRuntimeDetail {
  schema?: string;
  kind?: string;
  workflow_kind?: string;
  workflow?: string;
  node?: string;
  tool?: string;
  iteration?: number;
  current_phase?: string;
  progress_message?: string;
  message?: string;
  progress?: number;
  lifecycle_state?: string;
  [key: string]: unknown;
}

export interface BackgroundTaskProgressEvent {
  recorded_at: string;
  kind: string;
  workflow_kind?: string | null;
  node?: string | null;
  tool?: string | null;
  iteration?: number | null;
  phase?: string | null;
  message?: string | null;
  progress?: number | null;
}

export interface BackgroundTaskInfo {
  id: string;
  tool_name: string;
  tool_call_id?: string;
  status: "spawned" | "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string | null;
  output_files?: string[];
  error: string | null;
  session_key?: string;
  workflow_kind?: string | null;
  current_phase?: string | null;
  lifecycle_state?: string | null;
  runtime_detail?: BackgroundTaskRuntimeDetail | null;
  progress_message?: string | null;
  progress?: number | null;
  progress_events?: BackgroundTaskProgressEvent[];
}

export interface ServerStatus {
  version: string;
  model: string;
  provider: string;
  uptime_secs: number;
  agent_configured: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  created_at: string;
  last_login_at: string | null;
}

export interface AuthVerifyResponse {
  ok: boolean;
  token?: string;
  user?: AuthUser;
  message?: string;
}

export type PortalKind = "bootstrap_admin" | "admin" | "owner" | "sub_account";

export type ProfileRelationship =
  | "self_profile"
  | "managed_child"
  | "admin_managed";

export type ProfileApiScope = "self_service" | "sub_account" | "admin";

export interface AccessibleProfileSummary {
  id: string;
  name: string;
  parent_id?: string | null;
  relationship: ProfileRelationship;
  api_scope: ProfileApiScope;
  route_base: string;
  can_manage_sub_accounts: boolean;
}

export interface PortalState {
  kind: PortalKind;
  home_profile_id: string;
  home_route: string;
  can_access_admin_portal: boolean;
  can_manage_users: boolean;
  sub_account_limit: number;
  accessible_profiles: AccessibleProfileSummary[];
}

export interface ScopedAuthTarget {
  id: string;
  name: string;
  email_login_enabled: boolean;
}

export interface AuthStatusResponse {
  bootstrap_mode: boolean;
  email_login_enabled: boolean;
  admin_token_login_enabled: boolean;
  allow_self_registration: boolean;
  scoped_profile?: ScopedAuthTarget | null;
}

export interface AuthMeResponse {
  user: AuthUser;
  profile: unknown;
  portal: PortalState;
}

// SSE event types
export type SseEvent =
  | { type: "token"; text: string }
  | { type: "replace"; text: string }
  | { type: "tool_start"; tool: string; tool_call_id?: string; tool_id?: string }
  | { type: "tool_end"; tool: string; success: boolean; tool_call_id?: string; tool_id?: string }
  | { type: "tool_progress"; tool: string; message: string }
  | { type: "stream_end" }
  | {
      type: "cost_update";
      input_tokens: number;
      output_tokens: number;
      session_cost: number | null;
    }
  | { type: "thinking"; iteration: number }
  | { type: "response"; iteration: number }
  | {
      type: "file";
      path: string;
      filename: string;
      caption: string;
      tool_call_id?: string;
    }
  | {
      type: "done";
      content: string;
      model?: string;
      tokens_in?: number;
      tokens_out?: number;
      session_cost?: number | null;
      duration_s?: number;
      has_bg_tasks?: boolean;
    }
  | { type: "error"; message: string }
  | {
      type: "task_status";
      task: {
        id: string;
        tool_name: string;
        tool_call_id: string;
        status: "spawned" | "running" | "completed" | "failed";
        started_at: string;
        completed_at: string | null;
        output_files: string[];
        error: string | null;
        session_key?: string;
        /** Server-provided monotonic sequence; may also appear on envelope. */
        server_seq?: number;
        /** RFC3339 last-updated timestamp; may also appear on envelope. */
        updated_at?: string;
      };
      /** Server-provided monotonic sequence on the envelope. */
      server_seq?: number;
      /** RFC3339 last-updated timestamp on the envelope. */
      updated_at?: string;
    }
  | {
      type: "session_result";
      message: MessageInfo;
    }
  | { type: "other" };
