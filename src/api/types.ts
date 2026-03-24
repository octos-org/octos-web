// octos API types

export interface ChatRequest {
  message: string;
  session_id?: string;
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
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
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
  | { type: "file"; path: string; filename: string; caption: string }
  | {
      type: "done";
      content: string;
      model?: string;
      tokens_in?: number;
      tokens_out?: number;
      duration_s?: number;
    }
  | { type: "error"; message: string }
  | { type: "other" };
