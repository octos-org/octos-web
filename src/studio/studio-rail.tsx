import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Download, Eye, FileText, Image, Music, Table, Video, XCircle } from "lucide-react";

import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import {
  invokeSkillAction,
  listSkillActions,
  listSkillActionJobs,
  type SkillActionJob,
  type SkillActionJobStatus,
} from "@/api/skill-actions";
import { useAllFiles } from "@/store/file-store";

import { resolveStudioSkills } from "./action-catalog";
import { STUDIO_SKILL_ACTION_IDS, STUDIO_SKILL_LABEL_BY_ACTION_ID } from "./skills";
import { fileNameFromPath, relativeTime, sourceKind, type SourceKind } from "./source-media";
import { StudioFilePreviewDialog } from "./studio-file-preview";

interface Props {
  sessionId: string;
  historyTopic?: string;
  /**
   * Notebook source ids currently selected in the Sources pane. Their
   * count gates source-dependent skills; the sources are already imported
   * into the session workspace, so skill sends do not attach them as media.
   */
  selectedSources: string[];
  selectedSourceIds: string[];
}

const KIND_ICONS: Record<SourceKind, LucideIcon> = {
  image: Image,
  audio: Music,
  video: Video,
  table: Table,
  text: FileText,
};

const ASSET_LIST_CAP = 20;
const ACTIVE_JOB_STATUSES = new Set<SkillActionJobStatus>(["queued", "running"]);

interface GeneratedArtifact {
  id: string;
  filename: string;
  filePath: string;
  job: SkillActionJob;
}

function jobTimestamp(job: SkillActionJob): number {
  const parsed = Date.parse(job.updated_at || job.created_at);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Header-authenticated blob download: keeps the bearer token out of the
 * DOM (an <a href> with ?token= is copyable/leakable via "Copy Link").
 */
async function downloadAsset(
  filePath: string,
  filename: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(buildFileUrl(filePath, { sessionId }), {
    headers: buildApiHeaders(),
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const blobUrl = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.click();
  } finally {
    // Give the browser a beat to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  }
}

function mergeJobs(
  existing: readonly SkillActionJob[],
  incoming: readonly SkillActionJob[],
): SkillActionJob[] {
  const jobs = [...existing];
  for (const next of incoming) {
    if (!STUDIO_SKILL_ACTION_IDS.has(next.action_id)) continue;
    const index = jobs.findIndex((job) => job.job_id === next.job_id);
    if (index === -1) {
      jobs.push(next);
    } else if (jobTimestamp(next) >= jobTimestamp(jobs[index])) {
      jobs[index] = { ...jobs[index], ...next };
    }
  }
  return jobs.sort((a, b) => jobTimestamp(b) - jobTimestamp(a));
}

function jobStatusLabel(status: SkillActionJobStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Ready";
    case "failed":
      return "Failed";
    case "abandoned":
      return "Abandoned";
  }
}

function artifactsFromJob(job: SkillActionJob): GeneratedArtifact[] {
  if (!job.result || typeof job.result !== "object") return [];
  const files = (job.result as { files_to_send?: unknown }).files_to_send;
  if (!Array.isArray(files)) return [];

  const seen = new Set<string>();
  return files.flatMap((value, index) => {
    if (typeof value !== "string" || !value || seen.has(value)) return [];
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

export function StudioRail({ sessionId, selectedSources, selectedSourceIds }: Props) {
  const allFiles = useAllFiles();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<SkillActionJob[]>([]);
  const [skills, setSkills] = useState(() => resolveStudioSkills([]));
  const [previewArtifact, setPreviewArtifact] = useState<GeneratedArtifact | null>(null);
  const actionArtifacts = useMemo(
    () => jobs.flatMap(artifactsFromJob),
    [jobs],
  );
  const assets = useMemo(
    () =>
      allFiles
        .filter((f) => f.sessionId === sessionId)
        .filter((f) => !actionArtifacts.some((artifact) => artifact.filePath === f.filePath))
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, ASSET_LIST_CAP),
    [actionArtifacts, allFiles, sessionId],
  );

  useEffect(() => {
    let cancelled = false;
    const refreshActions = () => {
      void listSkillActions(sessionId, "studio.skills")
        .then((actions) => {
          if (!cancelled) setSkills(resolveStudioSkills(actions));
        })
        .catch(() => {
          if (!cancelled) setSkills(resolveStudioSkills([]));
        });
    };
    refreshActions();
    window.addEventListener("crew:bridge_connected", refreshActions);
    return () => {
      cancelled = true;
      window.removeEventListener("crew:bridge_connected", refreshActions);
    };
  }, [sessionId]);

  useEffect(() => {
    const onJobUpdated = (event: Event) => {
      const job = (event as CustomEvent<SkillActionJob>).detail;
      if (!job || job.session_id !== sessionId) return;
      setJobs((prev) => mergeJobs(prev, [job]));
    };
    window.addEventListener("crew:skill_action_job_updated", onJobUpdated);
    return () => {
      window.removeEventListener("crew:skill_action_job_updated", onJobUpdated);
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const restoreJobs = () => {
      void listSkillActionJobs(sessionId)
        .then((restored) => {
          if (!cancelled) {
            setJobs((current) => mergeJobs(current, restored));
          }
        })
        // The bridge may not be connected on first render. The connection
        // event below retries this persisted-job restore without surfacing a
        // spurious user-facing error.
        .catch(() => {});
    };

    restoreJobs();
    window.addEventListener("crew:bridge_connected", restoreJobs);
    return () => {
      cancelled = true;
      window.removeEventListener("crew:bridge_connected", restoreJobs);
    };
  }, [sessionId]);

  async function runSkill(skill: (typeof skills)[number]): Promise<void> {
    if (!skill.actionId) return;
    setActionError(null);
    setBusySkillId(skill.id);
    try {
      const args =
        selectedSourceIds.length > 0 ? { source_ids: selectedSourceIds } : {};
      const response = await invokeSkillAction(sessionId, skill.actionId, args);
      if (!response.ok) {
        const failed = response.results?.find((result) => !result.success);
        throw new Error(failed?.output || `${skill.label} failed to start`);
      }
      if (response.jobs?.length) {
        setJobs((prev) => mergeJobs(prev, response.jobs ?? []));
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `${skill.label} failed to start`,
      );
    } finally {
      setBusySkillId(null);
    }
  }

  const hasGeneratedItems = jobs.length > 0 || assets.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <h2 className="studio-headline shrink-0 text-2xl font-bold">Studio</h2>

      <section className="flex shrink-0 flex-col gap-3">
        <h3 className="text-lg font-medium text-text-strong">Skills</h3>
        <div className="grid grid-cols-3 gap-2">
          {skills.map((skill) => {
            const disabled =
              !skill.actionId ||
              busySkillId === skill.id ||
              (skill.requiresSources === true && selectedSources.length === 0);
            const Icon = skill.icon;
            const title = !skill.actionId
              ? (skill.unavailableReason ?? `${skill.label} is not available`)
              : skill.requiresSources === true && selectedSources.length === 0
                ? `${skill.label} needs at least one selected source`
                : skill.label;
            return (
              <button
                key={skill.id}
                type="button"
                disabled={disabled}
                aria-disabled={disabled}
                className={`studio-skill-tile${disabled ? " opacity-50" : ""}`}
                title={title}
                onClick={() => {
                  if (disabled) return;
                  void runSkill(skill);
                }}
              >
                <span className="studio-skill-tile-icon">
                  <Icon size={18} />
                </span>
                <span className="studio-skill-tile-label">
                  {skill.label}
                  {skill.badge && (
                    <span className="studio-skill-tile-badge">{skill.badge}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-lg font-medium text-text-strong">Generated Assets</h3>
        {actionError && (
          <p className="text-xs text-red-500" role="alert">
            {actionError}
          </p>
        )}
        {downloadError && (
          <p className="text-xs text-red-500" role="alert">
            {downloadError}
          </p>
        )}
        {!hasGeneratedItems ? (
          <div className="studio-empty-state text-xs">
            Assets your assistant produces will appear here.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {jobs.map((job) => {
              const artifacts = artifactsFromJob(job);
              if (artifacts.length > 0) {
                return artifacts.map((artifact) => {
                  const Icon = KIND_ICONS[sourceKind(artifact.filename)];
                  const actionLabel =
                    STUDIO_SKILL_LABEL_BY_ACTION_ID.get(job.action_id) ??
                    job.action_id;
                  return (
                    <li
                      key={artifact.id}
                      className="studio-list-row studio-card !rounded-xl p-3"
                    >
                      <Icon size={16} className="shrink-0 text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm leading-tight" title={artifact.filename}>
                          {artifact.filename}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted">
                          {actionLabel} - {relativeTime(jobTimestamp(job))}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="studio-ghost-button studio-asset-action shrink-0 p-1"
                        aria-label={`Preview ${artifact.filename}`}
                        onClick={() => setPreviewArtifact(artifact)}
                      >
                        <Eye size={14} />
                      </button>
                      <button
                        type="button"
                        className="studio-ghost-button studio-asset-action shrink-0 p-1"
                        aria-label={`Download ${artifact.filename}`}
                        onClick={() => {
                          setDownloadError(null);
                          downloadAsset(artifact.filePath, artifact.filename, sessionId).catch(
                            (err: unknown) => {
                              setDownloadError(
                                err instanceof Error ? err.message : "Download failed",
                              );
                            },
                          );
                        }}
                      >
                        <Download size={14} />
                      </button>
                    </li>
                  );
                });
              }
              const label =
                STUDIO_SKILL_LABEL_BY_ACTION_ID.get(job.action_id) ??
                job.action_id;
              const active = ACTIVE_JOB_STATUSES.has(job.status);
              return (
                <li
                  key={job.job_id}
                  className="studio-list-row studio-card !rounded-xl p-3"
                >
                  {job.status === "failed" || job.status === "abandoned" ? (
                    <XCircle size={16} className="shrink-0 text-red-500" />
                  ) : (
                    <FileText size={16} className="shrink-0 text-muted" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm leading-tight" title={label}>
                      {label}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {relativeTime(jobTimestamp(job))}
                    </span>
                    {job.error && (
                      <span className="mt-0.5 block truncate text-[11px] text-red-500">
                        {job.error}
                      </span>
                    )}
                  </span>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 font-label text-[10px] uppercase tracking-[0.04em] ${job.status === "failed" ? "text-red-500" : "text-muted"}`}
                    role={active ? "status" : undefined}
                  >
                    {jobStatusLabel(job.status)}
                  </span>
                </li>
              );
            })}
            {assets.map((file) => {
              const Icon = KIND_ICONS[sourceKind(file.filename)];
              return (
                <li
                  key={file.id}
                  className="studio-list-row studio-card !rounded-xl p-3"
                >
                  <Icon size={16} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-sm leading-tight"
                      title={file.filename}
                    >
                      {file.filename}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {relativeTime(file.timestamp)}
                    </span>
                  </span>
                  {file.status === "generating" ? (
                    <span
                      className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent"
                      role="status"
                      aria-label={`${file.filename} is generating`}
                    />
                  ) : (
                    <button
                      type="button"
                      className="studio-ghost-button studio-asset-action shrink-0 p-1"
                      aria-label={`Download ${file.filename}`}
                      onClick={() => {
                        setDownloadError(null);
                        downloadAsset(file.filePath, file.filename, sessionId).catch(
                          (err: unknown) => {
                            setDownloadError(
                              err instanceof Error
                                ? err.message
                                : "Download failed",
                            );
                          },
                        );
                      }}
                    >
                      <Download size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {previewArtifact && (
        <StudioFilePreviewDialog
          filename={previewArtifact.filename}
          filePath={previewArtifact.filePath}
          sessionId={sessionId}
          kind="asset"
          onClose={() => setPreviewArtifact(null)}
        />
      )}
    </div>
  );
}
