import type { SkillActionJob, SkillActionJobStatus } from "@/api/skill-actions";

import { STUDIO_SKILL_ACTION_IDS, STUDIO_SKILL_LABEL_BY_ACTION_ID } from "./skills";
import { fileNameFromPath } from "./source-media";

export interface GeneratedArtifact {
  id: string;
  filename: string;
  filePath: string;
  mediaType?: string;
  job: SkillActionJob;
}

const TERMINAL_JOB_STATUSES = new Set<SkillActionJobStatus>([
  "succeeded",
  "failed",
  "abandoned",
]);
const ACTIVE_JOB_STATUSES = new Set<SkillActionJobStatus>(["queued", "running"]);

export function jobTimestamp(job: SkillActionJob): number {
  const parsed = Date.parse(job.updated_at || job.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jobVersion(job: SkillActionJob): string {
  return job.updated_at || job.created_at;
}

function isNewerOrEqual(next: SkillActionJob, current: SkillActionJob): boolean {
  const nextTimestamp = jobTimestamp(next);
  const currentTimestamp = jobTimestamp(current);
  if (nextTimestamp !== currentTimestamp) return nextTimestamp > currentTimestamp;
  return jobVersion(next) >= jobVersion(current);
}

function isSafeArtifactPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

export function mergeStudioJobs(
  existing: readonly SkillActionJob[],
  incoming: readonly SkillActionJob[],
): SkillActionJob[] {
  const jobs = [...existing];
  for (const next of incoming) {
    if (!STUDIO_SKILL_ACTION_IDS.has(next.action_id)) continue;
    const index = jobs.findIndex((job) => job.job_id === next.job_id);
    if (index === -1) {
      jobs.push(next);
      continue;
    }

    const current = jobs[index];
    if (
      TERMINAL_JOB_STATUSES.has(current.status) &&
      ACTIVE_JOB_STATUSES.has(next.status)
    ) {
      continue;
    }
    if (isNewerOrEqual(next, current)) jobs[index] = { ...current, ...next };
  }
  return jobs.sort((a, b) => {
    const byTimestamp = jobTimestamp(b) - jobTimestamp(a);
    return byTimestamp || jobVersion(b).localeCompare(jobVersion(a));
  });
}

export function artifactsFromJob(job: SkillActionJob): GeneratedArtifact[] {
  if (job.status !== "succeeded" || !job.result || typeof job.result !== "object") {
    return [];
  }
  const result = job.result as {
    artifacts?: unknown;
    files_to_send?: unknown;
  };
  if (Array.isArray(result.artifacts)) {
    const seen = new Set<string>();
    return result.artifacts.flatMap((value, index) => {
      if (!value || typeof value !== "object") return [];
      const artifact = value as Record<string, unknown>;
      const handle = artifact.handle;
      if (
        typeof handle !== "string" ||
        !handle ||
        seen.has(handle) ||
        !isSafeArtifactPath(handle)
      ) {
        return [];
      }
      seen.add(handle);
      const displayName =
        typeof artifact.display_name === "string" && artifact.display_name.trim()
          ? artifact.display_name
          : fileNameFromPath(handle, job.action_id);
      return [{
        id: `${job.job_id}:${index}`,
        filename: displayName,
        filePath: handle,
        mediaType:
          typeof artifact.media_type === "string" ? artifact.media_type : undefined,
        job,
      }];
    });
  }

  const files = result.files_to_send;
  if (!Array.isArray(files)) return [];

  const seen = new Set<string>();
  return files.flatMap((value, index) => {
    if (
      typeof value !== "string" ||
      !value ||
      seen.has(value) ||
      !isSafeArtifactPath(value)
    ) {
      return [];
    }
    seen.add(value);
    return [{
      id: `${job.job_id}:${index}`,
      filename: fileNameFromPath(
        value,
        STUDIO_SKILL_LABEL_BY_ACTION_ID.get(job.action_id) ?? job.action_id,
      ),
      filePath: value,
      job,
    }];
  });
}
