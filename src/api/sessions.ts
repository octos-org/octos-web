import { request } from "./client";
import type { SessionInfo, MessageInfo } from "./types";

export interface SessionFileInfo {
  filename: string;
  path: string;
  size_bytes: number;
  modified_at: string;
}

export async function listSessions(): Promise<SessionInfo[]> {
  return request("/api/sessions");
}

export async function getMessages(
  sessionId: string,
  limit = 500,
  offset = 0,
): Promise<MessageInfo[]> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}&source=full`,
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function getSessionStatus(
  sessionId: string,
): Promise<{ active: boolean; has_deferred_files: boolean }> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/status`,
  );
}

export async function getSessionFiles(
  sessionId: string,
): Promise<SessionFileInfo[]> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/files`,
  );
}

export async function getStatus() {
  return request<{
    version: string;
    model: string;
    provider: string;
    uptime_secs: number;
    agent_configured: boolean;
  }>("/api/status");
}
