import { request } from "@/api/client";

// ── Types (aligned with real /api/my/profile response) ──

export interface LlmPrimary {
  family_id: string;
  model_id: string;
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
  patch: { name?: string; config?: Partial<ProfileConfig> },
): Promise<Profile | null> {
  try {
    return await request<Profile>("/api/my/profile", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  } catch {
    return null;
  }
}

export async function getMyProfileSkills(): Promise<SkillInfo[]> {
  try {
    const resp = await request<{ skills: SkillInfo[] }>("/api/my/profile/skills");
    return resp.skills ?? [];
  } catch {
    return [];
  }
}

export async function getMyProfileStatus(): Promise<ProfileStatus | null> {
  try {
    return await request<ProfileStatus>("/api/my/profile/status");
  } catch {
    return null;
  }
}

export async function startMyGateway(): Promise<{ ok: boolean; message?: string } | null> {
  try {
    return await request<{ ok: boolean; message?: string }>("/api/my/profile/start", {
      method: "POST",
    });
  } catch {
    return null;
  }
}

export async function stopMyGateway(): Promise<{ ok: boolean; message?: string } | null> {
  try {
    return await request<{ ok: boolean; message?: string }>("/api/my/profile/stop", {
      method: "POST",
    });
  } catch {
    return null;
  }
}

export async function restartMyGateway(): Promise<{ ok: boolean; message?: string } | null> {
  try {
    return await request<{ ok: boolean; message?: string }>("/api/my/profile/restart", {
      method: "POST",
    });
  } catch {
    return null;
  }
}

export async function removeSkill(name: string): Promise<boolean> {
  try {
    await request<void>(`/api/my/profile/skills/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    return true;
  } catch {
    return false;
  }
}

export interface InstallSkillResponse {
  ok: boolean;
  installed: string[];
  skipped: string[];
  deps_installed: string[];
}

export async function installSkill(source: string): Promise<boolean> {
  try {
    const resp = await request<InstallSkillResponse>("/api/my/profile/skills", {
      method: "POST",
      body: JSON.stringify({ repo: source }),
    });
    return resp.ok;
  } catch {
    return false;
  }
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

export async function getAdminUsers(): Promise<AdminUser[]> {
  try {
    const resp = await request<AdminUser[] | { users: AdminUser[] }>("/api/admin/users");
    return Array.isArray(resp) ? resp : (resp.users ?? []);
  } catch {
    return [];
  }
}

export async function createAdminUser(body: {
  email: string;
  name: string;
  user_id?: string;
  note?: string;
}): Promise<AdminUser | null> {
  try {
    return await request<AdminUser>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

export async function deleteAdminUser(id: string): Promise<boolean> {
  try {
    await request<void>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return true;
  } catch {
    return false;
  }
}

// ── Admin: Allowed Emails ──

export interface AllowedEmail {
  email: string;
}

export async function getAllowedEmails(): Promise<AllowedEmail[]> {
  try {
    const resp = await request<AllowedEmail[] | { emails: AllowedEmail[] }>("/api/admin/allowed-emails");
    return Array.isArray(resp) ? resp : (resp.emails ?? []);
  } catch {
    return [];
  }
}

export async function addAllowedEmail(email: string): Promise<boolean> {
  try {
    await request<void>("/api/admin/allowed-emails", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function removeAllowedEmail(email: string): Promise<boolean> {
  try {
    await request<void>(`/api/admin/allowed-emails/${encodeURIComponent(email)}`, {
      method: "DELETE",
    });
    return true;
  } catch {
    return false;
  }
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
  try {
    return await request<OperatorSummary>("/api/admin/operator/summary");
  } catch {
    return null;
  }
}

export async function fetchOperatorTasks(): Promise<OperatorTasksResponse | null> {
  try {
    return await request<OperatorTasksResponse>("/api/admin/operator/tasks");
  } catch {
    return null;
  }
}

export async function fetchAllProfiles(): Promise<Profile[]> {
  try {
    return await request<Profile[]>("/api/admin/profiles");
  } catch {
    return [];
  }
}

export async function startProfile(profileId: string): Promise<string | null> {
  try {
    await request<unknown>(`/api/admin/profiles/${encodeURIComponent(profileId)}/start`, {
      method: "POST",
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Failed to start";
  }
}

export async function stopProfile(profileId: string): Promise<string | null> {
  try {
    await request<unknown>(`/api/admin/profiles/${encodeURIComponent(profileId)}/stop`, {
      method: "POST",
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Failed to stop";
  }
}
