import {
  BridgeRpcError,
  BridgeStoppedError,
  BridgeTimeoutError,
  METHODS,
} from "@/runtime/ui-protocol-bridge";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import type { SkillActionJob } from "@/runtime/ui-protocol-types";

export type { SkillActionJob, SkillActionJobStatus } from "@/runtime/ui-protocol-types";

export interface SkillActionToolResult {
  success: boolean;
  output: string;
  file_modified?: string | null;
  artifacts?: Array<{
    handle: string;
    display_name: string;
    media_type: string;
    size: number;
    role?: string;
  }>;
  /** Legacy servers may still return raw relative paths. */
  files_to_send?: string[];
  structured_metadata?: unknown;
}

export interface SkillActionInvokeResponse {
  action_id: string;
  ok: boolean;
  materialized_paths?: string[];
  results?: SkillActionToolResult[];
  queued?: number;
  batch_id?: string;
  jobs?: SkillActionJob[];
}

export interface SkillActionDefinition {
  id: string;
  skill_id: string;
  label: string;
  description?: string;
  tags: string[];
  surfaces: string[];
  input_schema: Record<string, unknown>;
  ui_schema?: Record<string, unknown>;
  execution: "sync" | "background";
  available: boolean;
  unavailable_reason?: string;
}

export interface SkillActionJobListOptions {
  batchId?: string;
  actionId?: string;
}

function translateBridgeError(err: unknown): Error {
  if (err instanceof BridgeRpcError) return new Error(err.message);
  if (err instanceof BridgeTimeoutError) return new Error(err.message);
  if (err instanceof BridgeStoppedError) return new Error(err.message);
  if (err instanceof Error) return err;
  return new Error(String(err));
}

async function callSkillActionWs<T>(
  sessionId: string,
  method: string,
  params: unknown,
): Promise<T> {
  const bridge = getActiveBridge(sessionId);
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
  return callSkillActionWs<SkillActionInvokeResponse>(sessionId, METHODS.SKILL_ACTION_INVOKE, {
    session_id: sessionId,
    action_id: actionId,
    arguments: args,
  });
}

export async function listSkillActions(
  sessionId: string,
  surface?: string,
): Promise<SkillActionDefinition[]> {
  const params: Record<string, unknown> = { session_id: sessionId };
  if (surface) params.surface = surface;
  const response = await callSkillActionWs<{ actions?: SkillActionDefinition[] }>(
    sessionId,
    METHODS.SKILL_ACTION_LIST,
    params,
  );
  return response.actions ?? [];
}

export async function listSkillActionJobs(
  sessionId: string,
  options: SkillActionJobListOptions = {},
): Promise<SkillActionJob[]> {
  const params: Record<string, unknown> = { session_id: sessionId };
  if (options.batchId) {
    params.batch_id = options.batchId;
  }
  if (options.actionId) {
    params.action_id = options.actionId;
  }

  const response = await callSkillActionWs<{ jobs?: SkillActionJob[] }>(
    sessionId,
    METHODS.SKILL_ACTION_JOB_LIST,
    params,
  );
  return response.jobs ?? [];
}

export async function readSkillActionJob(
  sessionId: string,
  jobId: string,
): Promise<SkillActionJob> {
  const response = await callSkillActionWs<{ job: SkillActionJob }>(
    sessionId,
    METHODS.SKILL_ACTION_JOB_READ,
    { session_id: sessionId, job_id: jobId },
  );
  return response.job;
}
