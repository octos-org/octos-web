import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Download, FileText, Image, Music, Table, Video, XCircle } from "lucide-react";

import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import {
  invokeSkillAction,
  listSkillActions,
  listSkillActionJobs,
  type SkillActionJob,
} from "@/api/skill-actions";

import { resolveStudioSkills } from "./action-catalog";
import {
  buildStudioAssets,
  type AssetFile,
  type StudioAssetStatus,
  jobTimestamp,
  mergeStudioJobs,
} from "./generated-assets";
import { STUDIO_SKILL_LABEL_BY_ACTION_ID } from "./skills";
import { relativeTime, sourceKind, type SourceKind } from "./source-media";
import { StudioAssetPreview } from "./studio-asset-preview";

interface Props {
  sessionId: string;
  selectedAssetId: string | null;
  onSelectedAssetIdChange: (assetId: string | null) => void;
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
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    // Give the browser a beat to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  }
}

function assetStatusLabel(status: StudioAssetStatus): string {
  switch (status) {
    case "generating":
      return "Generating";
    case "ready":
      return "Ready";
    case "partial":
      return "Partial";
    case "failed":
      return "Failed";
    case "unavailable":
      return "Unavailable";
  }
}

export function StudioRail({
  sessionId,
  selectedAssetId,
  onSelectedAssetIdChange,
  selectedSources,
  selectedSourceIds,
}: Props) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<SkillActionJob[]>([]);
  const [skills, setSkills] = useState(() => resolveStudioSkills([]));

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
      setJobs((prev) => mergeStudioJobs(prev, [job]));
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
            setJobs((current) => mergeStudioJobs(current, restored));
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
        setJobs((prev) => mergeStudioJobs(prev, response.jobs ?? []));
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `${skill.label} failed to start`,
      );
    } finally {
      setBusySkillId(null);
    }
  }

  function startDownload(file: AssetFile): void {
    setDownloadError(null);
    downloadAsset(file.filePath, file.filename, sessionId).catch((err: unknown) => {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    });
  }

  const assets = buildStudioAssets(jobs);
  const selectedAsset = selectedAssetId
    ? assets.find((asset) => asset.id === selectedAssetId) ?? null
    : null;

  if (selectedAsset) {
    return (
      <StudioAssetPreview
        asset={selectedAsset}
        sessionId={sessionId}
        downloadError={downloadError}
        onBack={() => onSelectedAssetIdChange(null)}
        onDownload={startDownload}
      />
    );
  }

  const hasGeneratedItems = assets.length > 0;

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
            {assets.map((asset) => {
              const job = asset.job;
              const Icon = asset.status === "failed"
                ? XCircle
                : KIND_ICONS[sourceKind(asset.primary?.filename ?? "asset.md")];
              const actionLabel =
                STUDIO_SKILL_LABEL_BY_ACTION_ID.get(asset.actionId) ?? asset.actionId;
              const canOpen = asset.files.length > 0;
              const defaultDownload = asset.defaultDownload;
              return (
                <li
                  key={asset.id}
                  className="studio-list-row studio-card !rounded-xl p-3"
                >
                  <Icon
                    size={16}
                    className={`shrink-0 ${asset.status === "failed" ? "text-red-500" : "text-muted"}`}
                  />
                  {canOpen ? (
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      aria-label={`Open ${asset.title}`}
                      onClick={() => onSelectedAssetIdChange(asset.id)}
                    >
                      <span className="block truncate text-sm leading-tight" title={asset.title}>
                        {asset.title}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {actionLabel} - {relativeTime(jobTimestamp(job))}
                      </span>
                      {job.error && (
                        <span className="mt-0.5 block truncate text-[11px] text-red-500">
                          {job.error}
                        </span>
                      )}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm leading-tight" title={asset.title}>
                        {asset.title}
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
                  )}
                  {defaultDownload && (
                    <button
                      type="button"
                      className="studio-ghost-button studio-asset-action shrink-0 p-1"
                      aria-label={`Download ${asset.title}`}
                      onClick={() => startDownload(defaultDownload)}
                    >
                      <Download size={14} />
                    </button>
                  )}
                  {asset.status !== "ready" && (
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 font-label text-[10px] uppercase tracking-[0.04em] ${asset.status === "failed" ? "text-red-500" : "text-muted"}`}
                      role={asset.status === "generating" ? "status" : undefined}
                    >
                      {assetStatusLabel(asset.status)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
