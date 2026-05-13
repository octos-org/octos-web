import type {
  SessionInfo,
  MessageInfo,
  BackgroundTaskInfo,
  ServerStatus,
} from "./types";
import {
  BridgeRpcError,
  BridgeStoppedError,
  BridgeTimeoutError,
  METHODS,
} from "@/runtime/ui-protocol-bridge";
import { getAnyConnectedBridge } from "@/runtime/ui-protocol-runtime";
import {
  MESSAGES_PAGE_LIMIT_CAP,
  MESSAGES_PAGE_OFFSET_CAP,
} from "@/lib/constants";

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

export interface SessionStatusInfo {
  active: boolean;
  has_deferred_files: boolean;
  has_bg_tasks: boolean;
}

export interface SessionMessagesPage {
  messages: MessageInfo[];
  has_more: boolean;
  next_offset: number;
}

export interface SessionSnapshot {
  status: SessionStatusInfo;
  files: SessionFileInfo[];
  tasks: BackgroundTaskInfo[];
}

function translateBridgeError(err: unknown): Error {
  if (err instanceof BridgeRpcError) {
    return new Error(err.message);
  }
  if (err instanceof BridgeTimeoutError) {
    return new Error(err.message);
  }
  if (err instanceof BridgeStoppedError) {
    return new Error(err.message);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

async function callAuxWs<T>(method: string, params: unknown): Promise<T> {
  const bridge = getAnyConnectedBridge();
  if (!bridge) {
    throw new Error("ui-protocol-bridge: no connected bridge for " + method);
  }
  try {
    return await bridge.callMethod<T>(method, params);
  } catch (err) {
    throw translateBridgeError(err);
  }
}

export async function listSessions(): Promise<SessionInfo[]> {
  const result = await callAuxWs<{ sessions: SessionInfo[] }>(
    METHODS.SESSION_LIST,
    {},
  );
  return result.sessions ?? [];
}

function clampPagination(limit: number, offset: number): {
  limit: number;
  offset: number;
} {
  const clampedLimit = Math.max(
    0,
    Math.min(MESSAGES_PAGE_LIMIT_CAP, Math.floor(limit)),
  );
  const clampedOffset = Math.max(
    0,
    Math.min(MESSAGES_PAGE_OFFSET_CAP, Math.floor(offset)),
  );
  return { limit: clampedLimit, offset: clampedOffset };
}

export async function getMessages(
  sessionId: string,
  limit = 500,
  offset = 0,
  sinceSeq?: number,
  topic?: string,
): Promise<MessageInfo[]> {
  const { limit: clampedLimit, offset: clampedOffset } = clampPagination(
    limit,
    offset,
  );
  const params: Record<string, unknown> = {
    session_id: sessionId,
    limit: clampedLimit,
    offset: clampedOffset,
  };
  if (
    typeof sinceSeq === "number" &&
    Number.isFinite(sinceSeq) &&
    sinceSeq >= 0
  ) {
    params.since_seq = sinceSeq;
  }
  const trimmedTopic = topic?.trim();
  if (trimmedTopic) params.topic = trimmedTopic;
  const result = await callAuxWs<SessionMessagesPage>(
    METHODS.SESSION_MESSAGES_PAGE,
    params,
  );
  return result.messages ?? [];
}

export async function getMessagesPage(
  sessionId: string,
  limit = 500,
  offset = 0,
  sinceSeq?: number,
  topic?: string,
): Promise<SessionMessagesPage> {
  const { limit: clampedLimit, offset: clampedOffset } = clampPagination(
    limit,
    offset,
  );
  const params: Record<string, unknown> = {
    session_id: sessionId,
    limit: clampedLimit,
    offset: clampedOffset,
  };
  if (
    typeof sinceSeq === "number" &&
    Number.isFinite(sinceSeq) &&
    sinceSeq >= 0
  ) {
    params.since_seq = sinceSeq;
  }
  const trimmedTopic = topic?.trim();
  if (trimmedTopic) params.topic = trimmedTopic;
  return callAuxWs<SessionMessagesPage>(
    METHODS.SESSION_MESSAGES_PAGE,
    params,
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  await callAuxWs<Record<string, never>>(METHODS.SESSION_DELETE, {
    session_id: sessionId,
  });
}

export async function getSessionStatus(
  sessionId: string,
  topic?: string,
): Promise<SessionStatusInfo> {
  const params: Record<string, unknown> = { session_id: sessionId };
  const trimmedTopic = topic?.trim();
  if (trimmedTopic) params.topic = trimmedTopic;
  const result = await callAuxWs<{ status: SessionStatusInfo }>(
    METHODS.SESSION_STATUS_GET,
    params,
  );
  return result.status;
}

export async function getSessionFiles(
  sessionId: string,
): Promise<SessionFileInfo[]> {
  const result = await callAuxWs<{ files: SessionFileInfo[] }>(
    METHODS.SESSION_FILES_LIST,
    { session_id: sessionId },
  );
  return result.files ?? [];
}

export async function getSessionWorkspaceContract(
  sessionId: string,
): Promise<SessionWorkspaceContractInfo[]> {
  const result = await callAuxWs<{
    contracts: SessionWorkspaceContractInfo[];
  }>(METHODS.SESSION_WORKSPACE_GET, { session_id: sessionId });
  return result.contracts ?? [];
}

export async function getSessionTasks(
  sessionId: string,
  topic?: string,
): Promise<BackgroundTaskInfo[]> {
  const params: Record<string, unknown> = { session_id: sessionId };
  const trimmedTopic = topic?.trim();
  if (trimmedTopic) params.topic = trimmedTopic;
  const result = await callAuxWs<{ tasks: BackgroundTaskInfo[] }>(
    METHODS.SESSION_TASKS_LIST,
    params,
  );
  return result.tasks ?? [];
}

export async function getSessionSnapshot(
  sessionId: string,
  topic?: string,
): Promise<SessionSnapshot> {
  const params: Record<string, unknown> = { session_id: sessionId };
  const trimmedTopic = topic?.trim();
  if (trimmedTopic) params.topic = trimmedTopic;
  const result = await callAuxWs<SessionSnapshot>(
    METHODS.SESSION_SNAPSHOT,
    params,
  );
  return {
    status: result.status,
    files: result.files ?? [],
    tasks: result.tasks ?? [],
  };
}

export async function setSessionTitle(
  sessionId: string,
  title: string,
): Promise<{ session_id: string; title: string }> {
  return callAuxWs<{ session_id: string; title: string }>(
    METHODS.SESSION_TITLE_SET,
    { session_id: sessionId, title },
  );
}

export async function getStatus(): Promise<ServerStatus> {
  const result = await callAuxWs<{ status: ServerStatus }>(
    METHODS.SYSTEM_STATUS_GET,
    {},
  );
  return result.status;
}
