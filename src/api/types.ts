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
  thread_id?: string;
  timestamp: string;
  media?: string[];
  tool_calls?: { id?: string; name?: string }[];
  /** Per-thread sequence (UI Protocol v1 PersistedMessage). When the
   *  server emits a typed event the per-thread sequence may differ from
   *  the per-session `seq` — preserve it explicitly so thread ordering
   *  uses the right axis. Codex review #3. */
  intra_thread_seq?: number;
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
//
// PR #2 of M8.10 (#629) added a `thread_id` field on every emitted SSE
// payload (= the originating user message's `client_message_id`) so web
// clients with multiple in-flight threads can demultiplex events into the
// right per-thread bubble. The `done` event additionally carries
// `committed_seq` — the per-thread sequence the just-finalized assistant
// message holds in storage. Both fields are additive: legacy daemons may
// still emit events without them.
export type SseEvent =
  | { type: "token"; text: string; thread_id?: string }
  | { type: "replace"; text: string; thread_id?: string }
  | {
      type: "tool_start";
      tool: string;
      tool_call_id?: string;
      tool_id?: string;
      thread_id?: string;
    }
  | {
      type: "tool_end";
      tool: string;
      success: boolean;
      tool_call_id?: string;
      tool_id?: string;
      thread_id?: string;
    }
  | {
      type: "tool_progress";
      tool: string;
      message: string;
      tool_call_id?: string;
      tool_id?: string;
      thread_id?: string;
    }
  | { type: "stream_end"; thread_id?: string }
  | {
      type: "cost_update";
      input_tokens: number;
      output_tokens: number;
      session_cost: number | null;
      thread_id?: string;
    }
  | { type: "thinking"; iteration: number; thread_id?: string }
  | { type: "response"; iteration: number; thread_id?: string }
  | {
      type: "file";
      path: string;
      filename: string;
      caption: string;
      tool_call_id?: string;
      thread_id?: string;
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
      thread_id?: string;
      committed_seq?: number;
    }
  | { type: "error"; message: string; thread_id?: string }
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
      };
      thread_id?: string;
    }
  | {
      type: "session_result";
      message: MessageInfo;
      thread_id?: string;
    }
  | { type: "other" };
