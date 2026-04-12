// octos API types

export interface ChatRequest {
  message: string;
  session_id?: string;
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
  timestamp: string;
  media?: string[];
  tool_calls?: { id?: string; name?: string }[];
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

export interface AuthMeResponse {
  user: AuthUser;
  profile: unknown;
}

// SSE event types
export type SseEvent =
  | { type: "token"; text: string }
  | { type: "replace"; text: string }
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string; success: boolean }
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
  | { type: "file"; path: string; filename: string; caption: string; tool_call_id?: string }
  | {
      type: "done";
      content: string;
      model?: string;
      tokens_in?: number;
      tokens_out?: number;
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
      };
    }
  | { type: "other" };
