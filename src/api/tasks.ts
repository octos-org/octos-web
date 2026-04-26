import { request } from "./client";
import type {
  CancelTaskResponse,
  RestartFromNodeRequest,
  RestartFromNodeResponse,
} from "./types";

/**
 * M7.9 / W2 — task supervisor client wrappers.
 *
 * Both endpoints map 1:1 onto `octos-cli`'s API server:
 *
 * - `POST /api/tasks/{task_id}/cancel`           -> `cancelTask`
 * - `POST /api/tasks/{task_id}/restart-from-node` -> `restartTaskFromNode`
 *
 * The shared `request` helper already handles auth, profile-id headers,
 * and 401 → /login redirects. Errors bubble up with the typed response
 * body so the UI can map 404/409 to user-facing messaging.
 */

/**
 * Encode a task id for use in the URL path. UUIDv7 strings emitted by
 * the task supervisor are URL-safe today, but we still call
 * `encodeURIComponent` defensively so the API client never accidentally
 * concatenates a stray `#` or `?` from a future id schema.
 */
function encodeTaskId(taskId: string): string {
  return encodeURIComponent(taskId);
}

export async function cancelTask(taskId: string): Promise<CancelTaskResponse> {
  return request<CancelTaskResponse>(
    `/api/tasks/${encodeTaskId(taskId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function restartTaskFromNode(
  taskId: string,
  body: RestartFromNodeRequest = {},
): Promise<RestartFromNodeResponse> {
  return request<RestartFromNodeResponse>(
    `/api/tasks/${encodeTaskId(taskId)}/restart-from-node`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}
