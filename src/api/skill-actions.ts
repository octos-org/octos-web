import {
  BridgeRpcError,
  BridgeStoppedError,
  BridgeTimeoutError,
  METHODS,
} from "@/runtime/ui-protocol-bridge";
import { getAnyConnectedBridge } from "@/runtime/ui-protocol-runtime";

export interface SkillActionToolResult {
  success: boolean;
  output: string;
  file_modified?: string | null;
  files_to_send?: string[];
  structured_metadata?: unknown;
}

export interface SkillActionInvokeResponse {
  action_id: string;
  ok: boolean;
  materialized_paths?: string[];
  results?: SkillActionToolResult[];
}

function translateBridgeError(err: unknown): Error {
  if (err instanceof BridgeRpcError) return new Error(err.message);
  if (err instanceof BridgeTimeoutError) return new Error(err.message);
  if (err instanceof BridgeStoppedError) return new Error(err.message);
  if (err instanceof Error) return err;
  return new Error(String(err));
}

async function callSkillActionWs<T>(method: string, params: unknown): Promise<T> {
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

export async function invokeSkillAction(
  sessionId: string,
  actionId: string,
  args: Record<string, unknown>,
): Promise<SkillActionInvokeResponse> {
  return callSkillActionWs<SkillActionInvokeResponse>(METHODS.SKILL_ACTION_INVOKE, {
    session_id: sessionId,
    action_id: actionId,
    arguments: args,
  });
}
