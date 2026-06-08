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

export async function restartMyGateway(): Promise<{ ok: boolean; message?: string } | null> {
  try {
    return await request<{ ok: boolean; message?: string }>("/api/my/profile/restart", {
      method: "POST",
    });
  } catch {
    return null;
  }
}
