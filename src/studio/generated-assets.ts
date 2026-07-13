import type { SkillActionJob, SkillActionJobStatus } from "@/api/skill-actions";

import { STUDIO_SKILL_ACTION_IDS, STUDIO_SKILL_LABEL_BY_ACTION_ID } from "./skills";
import { fileNameFromPath } from "./source-media";

export interface GeneratedArtifact {
  id: string;
  filename: string;
  filePath: string;
  mediaType?: string;
  size?: number;
  role?: string;
  job: SkillActionJob;
}

export type StudioAssetStatus =
  | "generating"
  | "ready"
  | "partial"
  | "failed"
  | "unavailable";

export interface AssetFile extends GeneratedArtifact {
  role: string;
}

export interface StudioAsset {
  id: string;
  actionId: string;
  kind: string;
  title: string;
  status: StudioAssetStatus;
  statusReason?: string;
  primary?: AssetFile;
  defaultDownload?: AssetFile;
  files: AssetFile[];
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
  if (ACTIVE_JOB_STATUSES.has(job.status) || !job.result || typeof job.result !== "object") {
    return [];
  }
  const result = job.result as {
    artifacts?: unknown;
    files_to_send?: unknown;
  };
  if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
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
        size: typeof artifact.size === "number" ? artifact.size : undefined,
        role:
          typeof artifact.role === "string" && artifact.role.trim()
            ? artifact.role.trim().toLowerCase().replaceAll("_", "-")
            : undefined,
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

const ASSET_KIND_BY_ACTION_ID: Record<string, string> = {
  "reports.generate": "report",
  "quiz.generate": "quiz",
  "flashcards.generate": "flashcards",
  "mindmap.generate": "mind-map",
  "data_table.generate": "data-table",
  "video_overview.generate": "video-overview",
  "audio_overview.generate": "audio-overview",
  "slide_deck.generate": "slide-deck",
  "infographic.generate": "infographic",
};

function structuredTitle(job: SkillActionJob): string | undefined {
  if (!job.result || typeof job.result !== "object") return undefined;
  const result = job.result as Record<string, unknown>;
  const candidates = [
    result.title,
    result.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>).title
      : undefined,
    result.structured_metadata && typeof result.structured_metadata === "object"
      ? (result.structured_metadata as Record<string, unknown>).title
      : undefined,
  ];
  return candidates.find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  )?.trim();
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function artifactRoleFromFilename(kind: string, filename: string): string {
  const name = filename.toLowerCase();
  const extension = fileExtension(name);
  if (kind === "video-overview") {
    if (name.endsWith("overview.mp4") || extension === "mp4") return "video";
    if (name.endsWith("script.md")) return "script";
    if (name.endsWith("scene-plan.json")) return "scene-plan";
    if (name.endsWith("asset-brief.md")) return "asset-brief";
    if (name.endsWith("handoff.md")) return "handoff";
    if (name.endsWith("veo-prompt.txt")) return "prompt";
    if (name.endsWith("veo-operation.json")) return "metadata";
  }
  if (kind === "data-table") {
    if (name.endsWith("-citations.csv")) return "citations";
    if (extension === "csv") return "table";
    if (extension === "json") return "data";
    if (extension === "md" || extension === "markdown") return "document";
  }
  if (kind === "mind-map") {
    if (extension === "json") return "data";
    if (extension === "md" || extension === "markdown") return "document";
  }
  if (extension === "md" || extension === "markdown") return "document";
  if (extension === "json") return "data";
  if (extension === "csv") return "table";
  if (["mp4", "mov", "webm", "mkv"].includes(extension)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg"].includes(extension)) return "audio";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return "image";
  return "file";
}

function roleFromMediaType(mediaType?: string): string {
  const normalized = mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("image/")) return "image";
  if (normalized === "application/json") return "data";
  if (normalized === "text/csv") return "table";
  if (normalized === "text/markdown") return "document";
  return "file";
}

function artifactRole(kind: string, artifact: GeneratedArtifact): string {
  if (artifact.role) return artifact.role;
  const mediaRole = roleFromMediaType(artifact.mediaType);
  if (kind === "video-overview" && mediaRole === "video") return "video";

  const handleRole = artifactRoleFromFilename(
    kind,
    fileNameFromPath(artifact.filePath, artifact.filename),
  );
  if (handleRole !== "file") return handleRole;

  const displayRole = artifactRoleFromFilename(kind, artifact.filename);
  return displayRole !== "file" ? displayRole : mediaRole;
}

function assetStatus(
  job: SkillActionJob,
  kind: string,
  files: readonly AssetFile[],
): StudioAssetStatus {
  if (ACTIVE_JOB_STATUSES.has(job.status)) return "generating";
  if ((job.status === "failed" || job.status === "abandoned") && files.length > 0) {
    return "partial";
  }
  if (job.status === "failed" || job.status === "abandoned") return "failed";
  if (files.length === 0) return "unavailable";
  if (kind === "video-overview" && !files.some((file) => file.role === "video")) {
    return "partial";
  }
  if (kind === "mind-map" && !files.some((file) => file.role === "data")) {
    return "partial";
  }
  if (
    kind === "data-table"
    && !["data", "table", "citations"].every((role) =>
      files.some((file) => file.role === role)
    )
  ) {
    return "partial";
  }
  if (
    ["report", "quiz", "flashcards"].includes(kind)
    && !files.some((file) => file.role === "document")
  ) {
    return "partial";
  }
  return "ready";
}

function statusReason(
  job: SkillActionJob,
  kind: string,
  status: StudioAssetStatus,
  files: readonly AssetFile[],
): string | undefined {
  if (status === "failed") return job.error ?? job.output ?? "Generation failed.";
  if (status === "unavailable") return "Generation completed without a usable file.";
  if (status !== "partial") return undefined;
  if (job.status === "failed" || job.status === "abandoned") {
    return job.error ?? job.output ?? "Generation stopped after producing partial files.";
  }
  if (kind === "video-overview" && !files.some((file) => file.role === "video")) {
    const result = job.result && typeof job.result === "object"
      ? job.result as Record<string, unknown>
      : {};
    const data = result.data && typeof result.data === "object"
      ? result.data as Record<string, unknown>
      : {};
    const renderError = [result.video_error, data.video_error]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    return renderError
      ? `The plan is ready, but video rendering failed: ${renderError}`
      : "The plan is ready, but the rendered video is unavailable.";
  }
  if (kind === "mind-map") return "The canonical mind-map JSON is unavailable; using a fallback file.";
  if (kind === "data-table") return "Some canonical table or citation files are unavailable.";
  return "The canonical preview file is unavailable; using a fallback file.";
}

function primaryFile(kind: string, files: readonly AssetFile[]): AssetFile | undefined {
  if (kind === "video-overview") {
    return files.find((file) => file.role === "video")
      ?? files.find((file) => file.role === "script")
      ?? files[0];
  }
  if (kind === "data-table" || kind === "mind-map") {
    return files.find((file) => file.role === "data") ?? files[0];
  }
  if (kind === "audio-overview") {
    return files.find((file) => file.role === "audio") ?? files[0];
  }
  if (kind === "slide-deck") {
    return files.find((file) => file.mediaType === "application/pdf")
      ?? files.find((file) => file.role === "image")
      ?? files[0];
  }
  if (kind === "infographic") {
    return files.find((file) => file.role === "image") ?? files[0];
  }
  return files.find((file) => file.role === "document") ?? files[0];
}

export function buildStudioAsset(job: SkillActionJob): StudioAsset {
  const kind = ASSET_KIND_BY_ACTION_ID[job.action_id] ?? "generic";
  const files = artifactsFromJob(job).map<AssetFile>((artifact) => ({
    ...artifact,
    role: artifactRole(kind, artifact),
  }));
  const primary = primaryFile(kind, files);
  const defaultDownload = kind === "data-table"
    ? files.find((file) => file.role === "table") ?? primary
    : primary;
  const status = assetStatus(job, kind, files);
  return {
    id: job.job_id,
    actionId: job.action_id,
    kind,
    title:
      structuredTitle(job)
      ?? STUDIO_SKILL_LABEL_BY_ACTION_ID.get(job.action_id)
      ?? job.action_id,
    status,
    statusReason: statusReason(job, kind, status, files),
    primary,
    defaultDownload,
    files,
    job,
  };
}

export function buildStudioAssets(
  jobs: readonly SkillActionJob[],
): StudioAsset[] {
  return jobs.map(buildStudioAsset);
}
