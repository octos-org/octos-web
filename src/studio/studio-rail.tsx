import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Download, Eye, FileText, Image, Music, Table, Video, XCircle } from "lucide-react";

import {
  invokeSkillAction,
  listSkillActions,
  listSkillActionJobs,
  skillActionScopeId,
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
import { downloadStudioFile } from "./studio-file-download";
import type { CitationTarget } from "./structured-asset-viewers";
import { useAllFiles } from "@/store/file-store";

interface Props {
  sessionId: string;
  selectedAssetId?: string | null;
  onSelectedAssetIdChange?: (assetId: string | null) => void;
  historyTopic?: string;
  /**
   * Notebook source ids currently selected in the Sources pane. Their
   * count gates source-dependent skills; the sources are already imported
   * into the session workspace, so skill sends do not attach them as media.
   */
  selectedSourceIds: string[];
  selectedSources?: string[];
  onCitationOpen?: (citation: CitationTarget) => void;
}

const KIND_ICONS: Record<SourceKind, LucideIcon> = {
  image: Image,
  audio: Music,
  video: Video,
  table: Table,
  text: FileText,
};

const ACTIVE_JOB_POLL_INTERVAL_MS = 3_000;

type StudioActionCapability =
  | { status: "connecting"; reason: string }
  | { status: "supported"; reason: null }
  | { status: "unsupported" | "error"; reason: string };

function failedStudioCapability(error: unknown): StudioActionCapability {
  const message = error instanceof Error ? error.message : String(error);
  if (/rpc-error\[-32601\]|method (?:is )?not found/i.test(message)) {
    return {
      status: "unsupported",
      reason: "This Octos Core does not support scoped Studio actions.",
    };
  }
  return {
    status: "error",
    reason: "Studio action capabilities could not be verified. Reconnect and try again.",
  };
}

/**
 * Header-authenticated blob download: keeps the bearer token out of the
 * DOM (an <a href> with ?token= is copyable/leakable via "Copy Link").
 */
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
    case "cancelled":
      return "Cancelled";
    case "abandoned":
      return "Abandoned";
  }
}

export function StudioRail({
  sessionId,
  historyTopic,
  selectedAssetId: controlledSelectedAssetId,
  onSelectedAssetIdChange: controlledOnSelectedAssetIdChange,
  selectedSourceIds,
  onCitationOpen,
}: Props) {
  const scopeId = skillActionScopeId(sessionId, historyTopic);
  const allFiles = useAllFiles();
  const [internalSelectedAssetId, setInternalSelectedAssetId] = useState<string | null>(null);
  const selectedAssetId = controlledSelectedAssetId ?? internalSelectedAssetId;
  const changeSelectedAssetId =
    controlledOnSelectedAssetIdChange ?? setInternalSelectedAssetId;
  const [downloadError, setDownloadError] = useState<{
    assetId: string;
    message: string;
  } | null>(null);
  const downloadRequestId = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<SkillActionJob[]>([]);
  const [skills, setSkills] = useState(() => resolveStudioSkills([]));
  const [actionCapability, setActionCapability] =
    useState<StudioActionCapability>({
      status: "connecting",
      reason: "Checking the scoped Studio action capabilities…",
    });
  const actionCatalogRequest = useRef(0);
  const assetTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastAssetTriggerId = useRef<string | null>(null);
  const [restoreFocusId, setRestoreFocusId] = useState<string | null>(null);
  const assets = buildStudioAssets(jobs);
  const generatedPaths = new Set(
    assets.flatMap((asset) => asset.files.map((file) => file.filePath)),
  );
  const legacyAssets = allFiles
    .filter((file) => file.sessionId === sessionId && !generatedPaths.has(file.filePath))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20);
  const hasActiveJobs = assets.some((asset) => asset.status === "generating");

  useEffect(() => {
    let cancelled = false;
    const refreshActions = () => {
      const request = ++actionCatalogRequest.current;
      setBusySkillId(null);
      setActionError(null);
      setSkills(resolveStudioSkills([]));
      setJobs([]);
      setInternalSelectedAssetId(null);
      setActionCapability({
        status: "connecting",
        reason: "Checking the scoped Studio action capabilities…",
      });
      void listSkillActions(sessionId, "studio.skills", historyTopic)
        .then((actions) => {
          if (cancelled || request !== actionCatalogRequest.current) return;
          const resolved = resolveStudioSkills(actions);
          setSkills(resolved);
          setActionCapability(
            resolved.some((skill) => skill.actionId)
              ? { status: "supported", reason: null }
              : {
                  status: "unsupported",
                  reason:
                    "No notebook Studio action skill is installed for this session.",
                },
          );
        })
        .catch((error) => {
          if (cancelled || request !== actionCatalogRequest.current) return;
          setSkills(resolveStudioSkills([]));
          setActionCapability(failedStudioCapability(error));
        });
    };
    refreshActions();
    window.addEventListener("crew:bridge_connected", refreshActions);
    return () => {
      cancelled = true;
      window.removeEventListener("crew:bridge_connected", refreshActions);
    };
  }, [historyTopic, sessionId]);

  useEffect(() => {
    if (actionCapability.status !== "supported" || !hasActiveJobs) return;
    let cancelled = false;
    const poll = window.setInterval(() => {
      const request = actionCatalogRequest.current;
      void listSkillActionJobs(sessionId, {}, historyTopic)
        .then((restored) => {
          if (!cancelled && request === actionCatalogRequest.current) {
            setJobs((current) => mergeStudioJobs(
              current,
              restored.filter((job) => job.session_id === scopeId),
            ));
          }
        })
        .catch(() => {});
    }, ACTIVE_JOB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [actionCapability.status, hasActiveJobs, historyTopic, scopeId, sessionId]);

  useEffect(() => {
    if (actionCapability.status !== "supported") return;
    const onJobUpdated = (event: Event) => {
      const job = (event as CustomEvent<SkillActionJob>).detail;
      if (!job || job.session_id !== scopeId) return;
      setJobs((prev) => mergeStudioJobs(prev, [job]));
    };
    window.addEventListener("crew:skill_action_job_updated", onJobUpdated);
    return () => {
      window.removeEventListener("crew:skill_action_job_updated", onJobUpdated);
    };
  }, [actionCapability.status, scopeId]);

  useEffect(() => {
    if (actionCapability.status !== "supported") return;
    let cancelled = false;
    const request = actionCatalogRequest.current;
    // Capability discovery owns reconnect handling. A fresh successful
    // action/list result is required before each persisted-job restore.
    void listSkillActionJobs(sessionId, {}, historyTopic)
      .then((restored) => {
        if (!cancelled && request === actionCatalogRequest.current) {
          setJobs((current) =>
            mergeStudioJobs(
              current,
              restored.filter((job) => job.session_id === scopeId),
            ),
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [actionCapability.status, historyTopic, scopeId, sessionId]);

  async function runSkill(skill: (typeof skills)[number]): Promise<void> {
    if (!skill.actionId) return;
    const request = actionCatalogRequest.current;
    setActionError(null);
    setBusySkillId(skill.id);
    try {
      const args =
        selectedSourceIds.length > 0 ? { source_ids: selectedSourceIds } : {};
      const response = await invokeSkillAction(
        sessionId,
        skill.actionId,
        args,
        historyTopic,
      );
      if (request !== actionCatalogRequest.current) return;
      if (!response.ok) {
        const failed = response.results?.find((result) => !result.success);
        throw new Error(failed?.output || `${skill.label} failed to start`);
      }
      if (response.jobs?.length) {
        setJobs((prev) => mergeStudioJobs(prev, response.jobs ?? []));
      }
    } catch (err) {
      if (request !== actionCatalogRequest.current) return;
      setActionError(
        err instanceof Error ? err.message : `${skill.label} failed to start`,
      );
    } finally {
      if (request === actionCatalogRequest.current) {
        setBusySkillId(null);
      }
    }
  }

  function startDownload(file: AssetFile): void {
    const requestId = ++downloadRequestId.current;
    const assetId = file.job.job_id;
    setDownloadError(null);
    downloadStudioFile(file.filePath, file.filename, scopeId).catch((err: unknown) => {
      if (requestId !== downloadRequestId.current) return;
      setDownloadError({
        assetId,
        message: err instanceof Error ? err.message : "Download failed",
      });
    });
  }

  const selectedAsset = selectedAssetId
    ? assets.find((asset) => asset.id === selectedAssetId) ?? null
    : null;

  useEffect(() => {
    if (selectedAsset || !restoreFocusId) return;
    const trigger = assetTriggerRefs.current.get(restoreFocusId);
    if (trigger) {
      trigger.focus();
      setRestoreFocusId(null);
    }
  }, [restoreFocusId, selectedAsset]);

  if (selectedAsset) {
    return (
      <StudioAssetPreview
        asset={selectedAsset}
        sessionId={scopeId}
        downloadError={downloadError?.assetId === selectedAsset.id
          ? downloadError.message
          : null}
        onBack={() => {
          setRestoreFocusId(lastAssetTriggerId.current ?? selectedAsset.id);
          changeSelectedAssetId(null);
        }}
        onDownload={startDownload}
        onCitationOpen={onCitationOpen}
      />
    );
  }

  const hasGeneratedItems = assets.length > 0 || legacyAssets.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <h2 className="studio-headline shrink-0 text-2xl font-bold">Studio</h2>

      <section className="flex shrink-0 flex-col gap-3">
        <h3 className="text-lg font-medium text-text-strong">Skills</h3>
        {actionCapability.status !== "supported" && (
          <p
            className={`text-xs ${actionCapability.status === "error" ? "text-red-500" : "text-muted"}`}
            role="status"
          >
            {actionCapability.reason}
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">
          {skills.map((skill) => {
            const disabled =
              !skill.actionId ||
              busySkillId === skill.id ||
              (skill.requiresSources === true && selectedSourceIds.length === 0);
            const Icon = skill.icon;
            const title = !skill.actionId
              ? (skill.unavailableReason ?? `${skill.label} is not available`)
              : skill.requiresSources === true && selectedSourceIds.length === 0
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
            {downloadError.message}
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
                      ref={(node) => {
                        if (node) assetTriggerRefs.current.set(asset.id, node);
                        else assetTriggerRefs.current.delete(asset.id);
                      }}
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      aria-label={`Open ${asset.title}`}
                      onClick={() => {
                        lastAssetTriggerId.current = asset.id;
                        changeSelectedAssetId(asset.id);
                      }}
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
                      aria-label={`Preview ${asset.primary?.filename ?? asset.title}`}
                      onClick={() => {
                        lastAssetTriggerId.current = asset.id;
                        changeSelectedAssetId(asset.id);
                      }}
                    >
                      <Eye size={14} />
                    </button>
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
            {legacyAssets.map((file) => {
              const Icon = KIND_ICONS[sourceKind(file.filename)];
              return (
                <li
                  key={file.id}
                  className="studio-list-row studio-card !rounded-xl p-3"
                >
                  <Icon size={16} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm leading-tight" title={file.filename}>
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
                        const requestId = ++downloadRequestId.current;
                        setDownloadError(null);
                        downloadStudioFile(file.filePath, file.filename, scopeId)
                          .catch((err: unknown) => {
                            if (requestId !== downloadRequestId.current) return;
                            setDownloadError({
                              assetId: file.id,
                              message: err instanceof Error ? err.message : "Download failed",
                            });
                          });
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
    </div>
  );
}
