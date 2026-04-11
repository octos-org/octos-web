import { request } from "./client";
import type { SessionInfo, MessageInfo, BackgroundTaskInfo } from "./types";

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
  sinceSeq?: number,
): Promise<MessageInfo[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    source: "full",
  });
  if (typeof sinceSeq === "number" && Number.isFinite(sinceSeq) && sinceSeq >= 0) {
    params.set("since_seq", String(sinceSeq));
  }
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function getSessionStatus(
  sessionId: string,
): Promise<{ active: boolean; has_deferred_files: boolean; has_bg_tasks: boolean }> {
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

export async function getSessionTasks(
  sessionId: string,
): Promise<BackgroundTaskInfo[]> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks`,
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
