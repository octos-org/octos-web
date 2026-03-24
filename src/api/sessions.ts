import { request } from "./client";
import type { SessionInfo, MessageInfo } from "./types";

export async function listSessions(): Promise<SessionInfo[]> {
  return request("/api/sessions");
}

export async function getMessages(
  sessionId: string,
  limit = 500,
  offset = 0,
): Promise<MessageInfo[]> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}`,
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  const { getToken } = await import("./client");
  const { API_BASE } = await import("@/lib/constants");
  const token = getToken();
  const resp = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) {
    throw new Error(`Delete failed: HTTP ${resp.status}`);
  }
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
