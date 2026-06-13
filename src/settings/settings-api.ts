import { request } from "@/api/client";

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function apiErrorMessageFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const direct =
    stringFromUnknown(record.detail) ??
    stringFromUnknown(record.message) ??
    stringFromUnknown(record.error);
  if (direct) return direct;

  if (Array.isArray(record.detail)) {
    const parts = record.detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return null;
        const entry = item as Record<string, unknown>;
        return stringFromUnknown(entry.msg) ?? stringFromUnknown(entry.message);
      })
      .filter((item): item is string => Boolean(item));
    if (parts.length > 0) return parts.join("; ");
  }

  return null;
}

export function formatSettingsError(
  err: unknown,
  fallback = "Request failed.",
): string {
  if (err instanceof Error) {
    const trimmed = err.message.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        return apiErrorMessageFromBody(parsed) ?? trimmed;
      } catch {
        return trimmed;
      }
    }
  }
  if (typeof err === "string" && err.trim()) return err.trim();
  return fallback;
}

// ── Types (aligned with real /api/my/profile response) ──

export interface LlmPrimary {
  family_id: string;
  model_id: string;
  route?: {
    base_url?: string | null;
    api_key_env?: string | null;
  } | null;
}

export interface GatewayConfig {
  max_history: number | null;
  max_iterations: number | null;
  system_prompt: string | null;
  max_concurrent_sessions: number | null;
  browser_timeout_secs: number | null;
  max_output_tokens: number | null;
}

export interface SandboxDocker {
  image: string;
  cpu_limit: string | null;
  memory_limit: string | null;
  pids_limit: number | null;
  mount_mode: string;
  extra_binds: string[];
}

export interface SandboxConfig {
  enabled: boolean;
  mode: string;
  allow_network: boolean;
  docker: SandboxDocker;
  read_allow_paths: string[];
}

export interface ProfileConfig {
  llm: {
    primary: LlmPrimary;
    fallbacks: LlmPrimary[];
  };
  channels: unknown[];
  gateway: GatewayConfig;
  env_vars: Record<string, string>;
  hooks: unknown[];
  email: string | null;
  api_type: string | null;
  admin_mode: boolean;
  sandbox: SandboxConfig;
  adaptive_routing: unknown;
  content_routing: unknown;
  plugins: { require_signed: boolean };
}

export interface ProfileStatus {
  running: boolean;
  pid: number | null;
  started_at: string | null;
  uptime_secs: number | null;
}

export interface Profile {
  id: string;
  name: string;
  enabled: boolean;
  data_dir: string | null;
  config: ProfileConfig;
  created_at: string;
  updated_at: string;
  status: ProfileStatus;
}

export interface SkillInfo {
  name: string;
  source_repo: string | null;
  tool_count: number;
  version: string | null;
}

// ── API calls (self-service: /api/my/...) ──

export async function getMyProfile(): Promise<Profile | null> {
  try {
    return await request<Profile>("/api/my/profile");
  } catch {
    return null;
  }
}

export async function updateMyProfile(
  patch: { name?: string; enabled?: boolean; config?: Partial<ProfileConfig> },
): Promise<Profile> {
  return await request<Profile>("/api/my/profile", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function getMyProfileSkills(): Promise<SkillInfo[]> {
  const resp = await request<{ skills: SkillInfo[] }>("/api/my/profile/skills");
  return resp.skills ?? [];
}

export async function getMyProfileStatus(): Promise<ProfileStatus | null> {
  try {
    return await request<ProfileStatus>("/api/my/profile/status");
  } catch {
    return null;
  }
}

export async function startMyGateway(): Promise<{ ok: boolean; message?: string }> {
  return await request<{ ok: boolean; message?: string }>("/api/my/profile/start", {
    method: "POST",
  });
}

export async function stopMyGateway(): Promise<{ ok: boolean; message?: string }> {
  return await request<{ ok: boolean; message?: string }>("/api/my/profile/stop", {
    method: "POST",
  });
}

export async function restartMyGateway(): Promise<{ ok: boolean; message?: string }> {
  return await request<{ ok: boolean; message?: string }>("/api/my/profile/restart", {
    method: "POST",
  });
}

export async function removeSkill(name: string): Promise<void> {
  await request<void>(`/api/my/profile/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export interface InstallSkillResponse {
  ok: boolean;
  installed: string[];
  skipped: string[];
  deps_installed: string[];
  message?: string;
  error?: string;
  detail?: string;
}

export async function installSkill(source: string): Promise<InstallSkillResponse> {
  return await request<InstallSkillResponse>("/api/my/profile/skills", {
    method: "POST",
    body: JSON.stringify({ repo: source }),
  });
}

// ── Hub / Registry ──

export interface HubPackage {
  name: string;
  repo: string;
  description: string | null;
  author: string | null;
  license: string | null;
  version: string | null;
  provides_tools: boolean;
  skills: string[];
  tags: string[];
  requires: string[];
}

export async function getSkillRegistry(): Promise<HubPackage[]> {
  const resp = await request<{ packages: HubPackage[] }>("/api/my/profile/skills/registry");
  return resp.packages ?? [];
}

// ── Admin: Users management ──

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
  last_login: string | null;
}

interface AdminUserResponse {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
  last_login?: string | null;
  last_login_at?: string | null;
}

interface ProfileResponseEnvelope {
  email: string | null;
  profile: Profile;
  status: ProfileStatus;
}

function normalizeAdminUser(user: AdminUserResponse): AdminUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    created_at: user.created_at,
    last_login: user.last_login ?? user.last_login_at ?? null,
  };
}

export async function getAdminUsers(): Promise<AdminUser[]> {
  const resp = await request<AdminUserResponse[] | { users: AdminUserResponse[] }>("/api/admin/users");
  const users = Array.isArray(resp) ? resp : (resp.users ?? []);
  return users.map(normalizeAdminUser);
}

export async function createAdminUser(parentProfileId: string, body: {
  email: string;
  name: string;
  sub_account_id: string;
  public_subdomain: string;
  note?: string;
}): Promise<ProfileResponseEnvelope> {
  return await request<ProfileResponseEnvelope>(
    `/api/admin/profiles/${encodeURIComponent(parentProfileId)}/accounts`,
    {
      method: "POST",
      body: JSON.stringify({
        sub_account_id: body.sub_account_id,
        public_subdomain: body.public_subdomain,
        name: body.name,
        email: body.email,
      }),
    },
  );
}

export async function deleteAdminUser(id: string): Promise<void> {
  await request<void>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ── Admin: Allowed Emails ──

export interface AllowedEmail {
  email: string;
  note?: string | null;
  created_at?: string;
  claimed_user_id?: string | null;
  claimed_at?: string | null;
  registered?: boolean;
  registered_user_id?: string | null;
  registered_name?: string | null;
  last_login_at?: string | null;
}

export async function getAllowedEmails(): Promise<AllowedEmail[]> {
  const resp = await request<AllowedEmail[] | { emails?: AllowedEmail[]; entries?: AllowedEmail[] }>("/api/admin/allowed-emails");
  return Array.isArray(resp) ? resp : (resp.entries ?? resp.emails ?? []);
}

export async function addAllowedEmail(email: string): Promise<void> {
  await request<void>("/api/admin/allowed-emails", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function removeAllowedEmail(email: string): Promise<void> {
  await request<void>(`/api/admin/allowed-emails/${encodeURIComponent(email)}`, {
    method: "DELETE",
  });
}

// ── Admin API types ──

export interface BreakdownEntry {
  count: number;
  [key: string]: unknown;
}

export interface OperatorSource {
  scope: string;
  scrape_status: string;
  available: boolean;
  sample_count: number;
  totals: Record<string, number>;
}

export interface OperatorSummary {
  available: boolean;
  collection: {
    running_gateways: number;
    gateways_with_api_port: number;
    gateways_missing_api_port: number;
    scrape_failures: number;
    sources_observed: number;
    sources_with_metrics: number;
    sources_without_metrics: number;
    partial: boolean;
  };
  totals: Record<string, number>;
  breakdowns: Record<string, BreakdownEntry[]>;
  sources: OperatorSource[];
}

export interface OperatorTask {
  id: string;
  profile_id: string;
  tool_name: string;
  status: "queued" | "running" | "verifying" | "ready" | "failed";
  started_at: string;
  completed_at?: string | null;
  error?: string | null;
}

export interface OperatorTasksResponse {
  generated_at: string;
  stale_threshold_secs: number;
  tasks: OperatorTask[];
  totals_by_lifecycle: Record<string, number>;
  stale_count: number;
  missing_artifact_count: number;
  validator_failed_count: number;
  sources: unknown[];
  partial: boolean;
}

// ── Admin API calls ──

export async function fetchOperatorSummary(): Promise<OperatorSummary | null> {
  return await request<OperatorSummary>("/api/admin/operator/summary");
}

export async function fetchOperatorTasks(): Promise<OperatorTasksResponse | null> {
  return await request<OperatorTasksResponse>("/api/admin/operator/tasks");
}

export async function fetchAllProfiles(): Promise<Profile[]> {
  return await request<Profile[]>("/api/admin/profiles");
}

export async function startProfile(profileId: string): Promise<string | null> {
  try {
    await request<unknown>(`/api/admin/profiles/${encodeURIComponent(profileId)}/start`, {
      method: "POST",
    });
    return null;
  } catch (err) {
    return formatSettingsError(err, "Failed to start");
  }
}

export async function stopProfile(profileId: string): Promise<string | null> {
  try {
    await request<unknown>(`/api/admin/profiles/${encodeURIComponent(profileId)}/stop`, {
      method: "POST",
    });
    return null;
  } catch (err) {
    return formatSettingsError(err, "Failed to stop");
  }
}

export async function deleteAdminProfile(profileId: string): Promise<void> {
  await request<void>(`/api/admin/profiles/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  });
}

// ── Admin: OminiX platform skills ──

export interface PlatformSkillInfo {
  name: string;
  installed: boolean;
}

export interface OminixApiStatus {
  url: string;
  healthy: boolean;
  service_registered: boolean;
}

export interface PlatformModelsStatus {
  dir: string;
  asr: string[];
  tts: string[];
}

export interface PlatformSkillsStatus {
  platform_skills: PlatformSkillInfo[];
  skills_dir: string;
  ominix_api: OminixApiStatus;
  models: PlatformModelsStatus;
}

export interface OminixLogResponse {
  log_path: string;
  total_lines?: number;
  lines: string[];
  error?: string;
}

export interface PlatformSkillHealth {
  name: string;
  status: string;
  url: string;
  detail?: unknown;
}

export interface OminixCatalogModel {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  status?: string;
  role?: string;
  enabled_for_octos?: boolean;
  source?: {
    primary_url?: string;
    backup_urls?: string[];
    source_type?: string;
    repo_id?: string | null;
    revision?: string;
  };
  storage?: {
    local_path?: string;
    total_size_bytes?: number | null;
    total_size_display?: string | null;
  };
  runtime?: {
    memory_required_mb?: number;
    quantization?: string | null;
    inference_engine?: string | null;
  };
}

export interface OminixModelsResponse {
  models: OminixCatalogModel[];
}

export interface AdminActionResponse {
  ok: boolean;
  message?: string;
}

export type OminixServiceAction = "start" | "stop" | "restart";

const OMINIX_ADMIN_BASE = "/api/admin/platform-skills/ominix-api";

export async function fetchPlatformSkillsStatus(): Promise<PlatformSkillsStatus> {
  return await request<PlatformSkillsStatus>("/api/admin/platform-skills");
}

export async function fetchPlatformSkillHealth(
  name: string,
): Promise<PlatformSkillHealth> {
  return await request<PlatformSkillHealth>(
    `/api/admin/platform-skills/${encodeURIComponent(name)}/health`,
  );
}

export async function fetchOminixLogs(lines = 80): Promise<OminixLogResponse> {
  const safeLines = Math.max(1, Math.min(200, Math.round(lines)));
  return await request<OminixLogResponse>(
    `${OMINIX_ADMIN_BASE}/logs?lines=${safeLines}`,
  );
}

export async function fetchOminixPlatformModels(): Promise<OminixCatalogModel[]> {
  const resp = await request<OminixModelsResponse>(`${OMINIX_ADMIN_BASE}/models`);
  return resp.models ?? [];
}

export async function fetchOminixAvailableModels(): Promise<OminixCatalogModel[]> {
  const resp = await request<OminixModelsResponse>(
    `${OMINIX_ADMIN_BASE}/models/available`,
  );
  return resp.models ?? [];
}

export async function runOminixServiceAction(
  action: OminixServiceAction,
): Promise<AdminActionResponse> {
  return await request<AdminActionResponse>(`${OMINIX_ADMIN_BASE}/${action}`, {
    method: "POST",
  });
}

export async function installPlatformSkill(name: string): Promise<AdminActionResponse> {
  return await request<AdminActionResponse>(
    `/api/admin/platform-skills/${encodeURIComponent(name)}/install`,
    { method: "POST" },
  );
}

export async function removePlatformSkill(name: string): Promise<AdminActionResponse> {
  return await request<AdminActionResponse>(
    `/api/admin/platform-skills/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export async function downloadOminixModel(modelId: string): Promise<unknown> {
  return await request<unknown>(`${OMINIX_ADMIN_BASE}/models/download`, {
    method: "POST",
    body: JSON.stringify({ model_id: modelId }),
  });
}

export async function removeOminixModel(modelId: string): Promise<unknown> {
  return await request<unknown>(`${OMINIX_ADMIN_BASE}/models/remove`, {
    method: "POST",
    body: JSON.stringify({ model_id: modelId }),
  });
}

export async function enableOminixModel(
  modelId: string,
  role: "asr" | "tts",
): Promise<AdminActionResponse> {
  return await request<AdminActionResponse>(`${OMINIX_ADMIN_BASE}/models/enable`, {
    method: "POST",
    body: JSON.stringify({ model_id: modelId, role }),
  });
}

export async function disableOminixModel(modelId: string): Promise<AdminActionResponse> {
  return await request<AdminActionResponse>(`${OMINIX_ADMIN_BASE}/models/disable`, {
    method: "POST",
    body: JSON.stringify({ model_id: modelId }),
  });
}
