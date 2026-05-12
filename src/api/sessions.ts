import { request } from "./client";
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
import { isAuxRestToWsV1Enabled } from "@/lib/feature-flags";
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

// ---------------------------------------------------------------------------
// M12 Phase D-2: WS-or-REST wrappers under `auxiliary.rest_to_ws.v1`.
//
// Each wrapper checks the `auxiliary_rest_to_ws_v1` feature flag. When ON
// AND there is a live, `connected` UI Protocol v1 bridge, the call routes
// through the bridge's `callMethod()` and returns the result of the
// matching JSON-RPC method. When OFF or there is no live bridge, the
// wrapper falls through to the existing REST helper unchanged.
//
// Return types and error envelopes are identical across the two paths —
// WS `BridgeRpcError` / `BridgeTimeoutError` / `BridgeStoppedError` are
// translated into the same `Error` shape the REST `request()` helper
// throws on a non-OK response. Callers must not branch on the transport.
// ---------------------------------------------------------------------------

function shouldUseWs(): boolean {
  if (!isAuxRestToWsV1Enabled()) return false;
  return getAnyConnectedBridge() !== null;
}

function translateBridgeError(err: unknown): Error {
  // Match the existing REST helper's error envelope: a plain `Error`
  // whose `message` is the server-provided text (or a `HTTP NNN`
  // string). Codex review M9-β-2 prefers a single `Error` subclass at
  // the wrapper boundary so panels can drop both code paths into one
  // `try { ... } catch (e: any) { setError(e.message) }`.
  //
  // Phase D-2 intentionally does NOT trigger the REST 401 reaper on WS
  // auth failures. See ADR PR #910 — Phase D-4 narrows the reaper scope,
  // so cross-transport coupling here is undesirable.
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
    // shouldUseWs() guarantees this is unreachable at the call sites
    // below, but a defensive throw keeps the type narrow.
    throw new Error("ui-protocol-bridge: no connected bridge for " + method);
  }
  try {
    return await bridge.callMethod<T>(method, params);
  } catch (err) {
    throw translateBridgeError(err);
  }
}

// ---------------------------------------------------------------------------
// session/list — `GET /api/sessions`
// ---------------------------------------------------------------------------

export async function listSessions(): Promise<SessionInfo[]> {
  if (shouldUseWs()) {
    const result = await callAuxWs<{ sessions: SessionInfo[] }>(
      METHODS.SESSION_LIST,
      {},
    );
    return result.sessions ?? [];
  }
  return request("/api/sessions");
}

// ---------------------------------------------------------------------------
// session/messages_page — `GET /api/sessions/:id/messages`
// ---------------------------------------------------------------------------

// Clamp pagination args to the same caps the server applies in both
// transports, BEFORE branching, so REST-synthesized pagination metadata
// matches the WS-returned metadata when callers exceed the caps.
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
  if (shouldUseWs()) {
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

  const params = new URLSearchParams({
    limit: String(clampedLimit),
    offset: String(clampedOffset),
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

/**
 * M12 Phase D-2: the WS variant of `getMessages` also returns the
 * `has_more` / `next_offset` pagination metadata, useful for the future
 * paged history loader. Phase D-3 panels can call this directly when
 * they want pagination state; the legacy REST array shape is
 * preserved by `getMessages` for back-compat.
 */
export async function getMessagesPage(
  sessionId: string,
  limit = 500,
  offset = 0,
  sinceSeq?: number,
  topic?: string,
): Promise<SessionMessagesPage> {
  // Clamp once, up-front, so both transports see the same effective
  // limit/offset and the REST fallback's synthesized `next_offset` /
  // `has_more` match the WS server's clamped metadata.
  const { limit: clampedLimit, offset: clampedOffset } = clampPagination(
    limit,
    offset,
  );
  if (shouldUseWs()) {
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

  // REST fallback: synthesize the pagination metadata from the array
  // shape the existing handler returns. has_more is true iff a full
  // page was returned (matches the server-side dispatcher in PR #912).
  // Use the clamped values so the metadata is consistent across transports.
  const messages = await getMessages(
    sessionId,
    clampedLimit,
    clampedOffset,
    sinceSeq,
    topic,
  );
  const hasMore = messages.length === clampedLimit;
  return {
    messages,
    has_more: hasMore,
    next_offset: hasMore
      ? clampedOffset + clampedLimit
      : clampedOffset + messages.length,
  };
}

// ---------------------------------------------------------------------------
// session/delete — `DELETE /api/sessions/:id`
// ---------------------------------------------------------------------------

export async function deleteSession(sessionId: string): Promise<void> {
  if (shouldUseWs()) {
    await callAuxWs<Record<string, never>>(METHODS.SESSION_DELETE, {
      session_id: sessionId,
    });
    return;
  }
  await request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// session/status.get — `GET /api/sessions/:id/status`
// ---------------------------------------------------------------------------

export async function getSessionStatus(
  sessionId: string,
  topic?: string,
): Promise<SessionStatusInfo> {
  if (shouldUseWs()) {
    const params: Record<string, unknown> = { session_id: sessionId };
    const trimmedTopic = topic?.trim();
    if (trimmedTopic) params.topic = trimmedTopic;
    const result = await callAuxWs<{ status: SessionStatusInfo }>(
      METHODS.SESSION_STATUS_GET,
      params,
    );
    return result.status;
  }
  const params = new URLSearchParams();
  if (topic?.trim()) {
    params.set("topic", topic.trim());
  }
  const query = params.toString();
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/status${query ? `?${query}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// session/files.list — `GET /api/sessions/:id/files`
// ---------------------------------------------------------------------------

export async function getSessionFiles(
  sessionId: string,
): Promise<SessionFileInfo[]> {
  if (shouldUseWs()) {
    const result = await callAuxWs<{ files: SessionFileInfo[] }>(
      METHODS.SESSION_FILES_LIST,
      { session_id: sessionId },
    );
    return result.files ?? [];
  }
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/files`);
}

// ---------------------------------------------------------------------------
// session/workspace.get — `GET /api/sessions/:id/workspace-contract`
// ---------------------------------------------------------------------------

export async function getSessionWorkspaceContract(
  sessionId: string,
): Promise<SessionWorkspaceContractInfo[]> {
  if (shouldUseWs()) {
    const result = await callAuxWs<{
      contracts: SessionWorkspaceContractInfo[];
    }>(METHODS.SESSION_WORKSPACE_GET, { session_id: sessionId });
    return result.contracts ?? [];
  }
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/workspace-contract`,
  );
}

// ---------------------------------------------------------------------------
// session/tasks.list — `GET /api/sessions/:id/tasks`
// ---------------------------------------------------------------------------

export async function getSessionTasks(
  sessionId: string,
  topic?: string,
): Promise<BackgroundTaskInfo[]> {
  if (shouldUseWs()) {
    const params: Record<string, unknown> = { session_id: sessionId };
    const trimmedTopic = topic?.trim();
    if (trimmedTopic) params.topic = trimmedTopic;
    const result = await callAuxWs<{ tasks: BackgroundTaskInfo[] }>(
      METHODS.SESSION_TASKS_LIST,
      params,
    );
    return result.tasks ?? [];
  }
  const params = new URLSearchParams();
  if (topic?.trim()) {
    params.set("topic", topic.trim());
  }
  const query = params.toString();
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks${query ? `?${query}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// session/snapshot — bundle of (status, files, tasks)
//
// REST has no single endpoint for this; the legacy callsite issued the
// three separate REST calls in parallel. Mirror that behavior for the
// flag-off path so the wrapper return shape is identical regardless of
// transport.
// ---------------------------------------------------------------------------

export async function getSessionSnapshot(
  sessionId: string,
  topic?: string,
): Promise<SessionSnapshot> {
  if (shouldUseWs()) {
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
  const [status, files, tasks] = await Promise.all([
    getSessionStatus(sessionId, topic),
    getSessionFiles(sessionId),
    getSessionTasks(sessionId, topic),
  ]);
  return { status, files, tasks };
}

// ---------------------------------------------------------------------------
// session/title.set — `PATCH /api/sessions/:id/title`
//
// This wrapper is NEW in Phase D-2 — there was no existing REST helper
// for the title rename in `src/api/sessions.ts` (the legacy panels did
// inline `fetch()` calls). The REST fallback mirrors the request body
// shape the existing PATCH handler accepts.
// ---------------------------------------------------------------------------

export async function setSessionTitle(
  sessionId: string,
  title: string,
): Promise<{ session_id: string; title: string }> {
  if (shouldUseWs()) {
    return callAuxWs<{ session_id: string; title: string }>(
      METHODS.SESSION_TITLE_SET,
      { session_id: sessionId, title },
    );
  }
  await request(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
  // The REST PATCH returns 204 No Content. Echo the rename back to the
  // caller so the WS and REST shapes are identical.
  return { session_id: sessionId, title };
}

// ---------------------------------------------------------------------------
// system/status.get — `GET /api/status`
// ---------------------------------------------------------------------------

export async function getStatus(): Promise<ServerStatus> {
  if (shouldUseWs()) {
    const result = await callAuxWs<{ status: ServerStatus }>(
      METHODS.SYSTEM_STATUS_GET,
      {},
    );
    return result.status;
  }
  return request<ServerStatus>("/api/status");
}
