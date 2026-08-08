import type {
  SessionBeforeSendResult,
  SessionSendRequest,
} from "@/runtime/session-context";

export function withNotebookToolContext(
  request: SessionSendRequest,
): SessionBeforeSendResult {
  return { ...request, toolContext: "notebook" };
}
