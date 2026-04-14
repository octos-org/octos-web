import { request } from "./client";
import type { SessionInfo, MessageInfo, BackgroundTaskInfo } from "./types";

export interface SessionFileInfo {
  filename: string;
  path: string;
  size_bytes: number;
  modified_at: string;
}

export interface SessionWorkspaceCheckInfo {
  spec: string;
  passed: boolean;
  reason?: string | null;
}

export interface SessionWorkspaceArtifactInfo {
  name: string;
  pattern: string;
  present: boolean;
  matches: string[];
}

export interface SessionWorkspaceContractInfo {
  repo_label: string;
  kind: string;
  slug: string;
  policy_managed: boolean;
  revision?: string | null;
  dirty: boolean;
  ready: boolean;
  error?: string | null;
  turn_end_checks: SessionWorkspaceCheckInfo[];
  completion_checks: SessionWorkspaceCheckInfo[];
  artifacts: SessionWorkspaceArtifactInfo[];
}

export async function listSessions(): Promise<SessionInfo[]> {
  return request("/api/sessions");
}

export async function getMessages(
  sessionId: string,
  limit = 500,
  offset = 0,
  sinceSeq?: number,
  topic?: string,
): Promise<MessageInfo[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    source: "full",
  });
  if (
    typeof sinceSeq === "number" &&
    Number.isFinite(sinceSeq) &&
    sinceSeq >= 0
  ) {
    params.set("since_seq", String(sinceSeq));
  }
  if (topic?.trim()) {
    params.set("topic", topic.trim());
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
  topic?: string,
): Promise<{
  active: boolean;
  has_deferred_files: boolean;
  has_bg_tasks: boolean;
}> {
  const params = new URLSearchParams();
  if (topic?.trim()) {
    params.set("topic", topic.trim());
  }
  const query = params.toString();
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/status${query ? `?${query}` : ""}`,
  );
}

export async function getSessionFiles(
  sessionId: string,
): Promise<SessionFileInfo[]> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
}

export async function getSessionWorkspaceContract(
  sessionId: string,
): Promise<SessionWorkspaceContractInfo[]> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/workspace-contract`,
  );
}

export async function getSessionTasks(
  sessionId: string,
  topic?: string,
): Promise<BackgroundTaskInfo[]> {
  const params = new URLSearchParams();
  if (topic?.trim()) {
    params.set("topic", topic.trim());
  }
  const query = params.toString();
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks${query ? `?${query}` : ""}`,
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
