import { useCallback, useEffect, useRef, useState } from "react";

import {
  listSkillActions,
  listSkillActionJobs,
  skillActionScopeId,
  type SkillActionJob,
} from "@/api/skill-actions";

import {
  SOURCE_IMPORT_ACTION_ID,
  SOURCE_LIST_ACTION_ID,
  SOURCE_REMOVE_ACTION_ID,
  SOURCE_RENAME_ACTION_ID,
  isSourceRowReady,
  mergeSourceImportJobs,
  mergeSourceRows,
  sourceRowFromSkillActionJob,
  type SourceRow,
} from "./source-media";
import { loadSourceCatalog } from "./source-store";

interface SourceState {
  scopeId: string;
  selectedSourceIds: string[];
  uploadedSources: SourceRow[];
  sourcesLoading: boolean;
  hasActiveImportJobs: boolean;
  sourcesCapability: NotebookSourcesCapability;
}

export type NotebookSourcesCapability =
  | { status: "connecting"; reason: string }
  | { status: "supported"; reason: null }
  | { status: "unsupported" | "error"; reason: string };

const REQUIRED_SOURCE_ACTION_IDS = [
  SOURCE_LIST_ACTION_ID,
  SOURCE_IMPORT_ACTION_ID,
  SOURCE_RENAME_ACTION_ID,
  SOURCE_REMOVE_ACTION_ID,
] as const;

function initialSourceState(scopeId: string): SourceState {
  return {
    scopeId,
    selectedSourceIds: [],
    uploadedSources: [],
    sourcesLoading: true,
    hasActiveImportJobs: false,
    sourcesCapability: {
      status: "connecting",
      reason: "Checking the scoped notebook source capabilities…",
    },
  };
}

function unsupportedSourceCapability(
  actions: Awaited<ReturnType<typeof listSkillActions>>,
): NotebookSourcesCapability | null {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const missing = REQUIRED_SOURCE_ACTION_IDS.filter(
    (id) => !byId.get(id)?.available,
  );
  if (missing.length === 0) return null;

  const reasons = missing
    .map((id) => byId.get(id)?.unavailable_reason)
    .filter((reason): reason is string => Boolean(reason));
  const detail =
    reasons.length > 0
      ? ` ${Array.from(new Set(reasons)).join(" ")}`
      : "";
  return {
    status: "unsupported",
    reason: `The notebook source skill is not installed or does not expose: ${missing.join(", ")}.${detail}`,
  };
}

function failedSourceCapability(error: unknown): NotebookSourcesCapability {
  const message = error instanceof Error ? error.message : String(error);
  if (/rpc-error\[-32601\]|method (?:is )?not found/i.test(message)) {
    return {
      status: "unsupported",
      reason:
        "This Octos Core does not support scoped skill actions. Update Core to use Notebook Sources.",
    };
  }
  return {
    status: "error",
    reason:
      "Notebook source capabilities could not be verified. Reconnect to Octos Core and try again.",
  };
}

function normalizedPaths(row: SourceRow): string[] {
  return [row.path, row.sourcePath, row.inputPath, row.materializedPath, row.previewPath]
    .filter((path): path is string => Boolean(path))
    .map((path) => path.replaceAll("\\", "/"));
}

function sameSourceRow(a: SourceRow, b: SourceRow): boolean {
  if (a.sourceId && b.sourceId) return a.sourceId === b.sourceId;
  if (a.jobId && b.jobId) return a.jobId === b.jobId;
  if (a.sourcePath && b.sourcePath) {
    return a.sourcePath.replaceAll("\\", "/")
      === b.sourcePath.replaceAll("\\", "/");
  }
  const bPaths = new Set(normalizedPaths(b));
  return normalizedPaths(a).some((path) => bPaths.has(path));
}

function hasStrongSourceIdentityMatch(a: SourceRow, b: SourceRow): boolean {
  return Boolean(
    (a.sourceId && b.sourceId && a.sourceId === b.sourceId)
    || (a.jobId && b.jobId && a.jobId === b.jobId)
    || (a.sourcePath && b.sourcePath
      && a.sourcePath.replaceAll("\\", "/")
        === b.sourcePath.replaceAll("\\", "/")),
  );
}

interface ScopedJobState {
  scopeId: string;
  jobs: SkillActionJob[];
  dismissedIds: Set<string>;
}

/**
 * Owns the notebook source catalog, transient import jobs, and selection for
 * one session/topic scope. Both Studio and Workspace use this controller so
 * job ordering, catalog reconciliation, and scope isolation stay identical.
 */
export function useNotebookSources(sessionId: string, topic?: string) {
  const scopeId = skillActionScopeId(sessionId, topic);
  const [state, setState] = useState<SourceState>(() =>
    initialSourceState(scopeId),
  );
  const sourceCapabilityRequest = useRef(0);
  const sourceCatalogRequest = useRef(0);
  const jobState = useRef<ScopedJobState>({
    scopeId,
    jobs: [],
    dismissedIds: new Set(),
  });

  const sourcesCapability =
    state.scopeId === scopeId
      ? state.sourcesCapability
      : initialSourceState(scopeId).sourcesCapability;
  const capabilitySupported = sourcesCapability.status === "supported";
  const selectedSourceIds =
    state.scopeId === scopeId && capabilitySupported
      ? state.selectedSourceIds
      : [];
  const uploadedSources =
    state.scopeId === scopeId && capabilitySupported
      ? state.uploadedSources
      : [];
  const sourcesLoading =
    state.scopeId === scopeId ? state.sourcesLoading : true;
  const hasActiveImportJobs =
    state.scopeId === scopeId && capabilitySupported
      ? state.hasActiveImportJobs
      : false;

  const selectedSources = selectedSourceIds
    .map((sourceId) => {
      const row = uploadedSources.find((candidate) => candidate.sourceId === sourceId);
      return row?.sourcePath ?? row?.path;
    })
    .filter((path): path is string => Boolean(path));

  useEffect(() => {
    let cancelled = false;
    const refreshCapabilities = () => {
      const request = ++sourceCapabilityRequest.current;
      sourceCatalogRequest.current += 1;
      jobState.current = { scopeId, jobs: [], dismissedIds: new Set() };
      setState((current) =>
        ({
          ...(current.scopeId === scopeId
            ? current
            : initialSourceState(scopeId)),
          sourcesLoading: true,
          sourcesCapability: {
            status: "connecting",
            reason: "Checking the scoped notebook source capabilities…",
          },
        }),
      );
      void listSkillActions(sessionId, "studio.sources", topic)
        .then((actions) => {
          if (cancelled || request !== sourceCapabilityRequest.current) return;
          const unsupported = unsupportedSourceCapability(actions);
          setState((current) =>
            current.scopeId === scopeId
              ? {
                  ...current,
                  selectedSourceIds: unsupported
                    ? []
                    : current.selectedSourceIds,
                  uploadedSources: unsupported ? [] : current.uploadedSources,
                  sourcesLoading: unsupported ? false : current.sourcesLoading,
                  hasActiveImportJobs: unsupported
                    ? false
                    : current.hasActiveImportJobs,
                  sourcesCapability: unsupported ?? {
                    status: "supported",
                    reason: null,
                  },
                }
              : current,
          );
        })
        .catch((error) => {
          if (cancelled || request !== sourceCapabilityRequest.current) return;
          setState((current) =>
            current.scopeId === scopeId
              ? {
                  ...current,
                  selectedSourceIds: [],
                  uploadedSources: [],
                  sourcesLoading: false,
                  hasActiveImportJobs: false,
                  sourcesCapability: failedSourceCapability(error),
                }
              : current,
          );
        });
    };

    refreshCapabilities();
    window.addEventListener("crew:bridge_connected", refreshCapabilities);
    return () => {
      cancelled = true;
      window.removeEventListener("crew:bridge_connected", refreshCapabilities);
    };
  }, [scopeId, sessionId, topic]);

  const mergeUploadedSourceRows = useCallback(
    (rows: SourceRow[]) => {
      setState((current) => current.scopeId === scopeId
        ? { ...current, uploadedSources: mergeSourceRows(current.uploadedSources, rows) }
        : current);
    },
    [scopeId],
  );

  const refreshSourceCatalog = useCallback(async () => {
    const request = ++sourceCatalogRequest.current;
    try {
      const catalog = await loadSourceCatalog(sessionId, topic);
      if (request !== sourceCatalogRequest.current) return;
      setState((current) => {
        if (current.scopeId !== scopeId) return current;
        const readyJobRows = jobState.current.scopeId === scopeId
          ? jobState.current.jobs
              .filter((job) => job.status === "succeeded")
              .map((job) => sourceRowFromSkillActionJob(job))
          : [];
        const claimedJobIds = new Set<string>();
        const catalogRows = catalog.map((row) => {
          const jobRow = readyJobRows.find((candidate) => {
            if (!candidate.jobId || claimedJobIds.has(candidate.jobId)) return false;
            if (!sameSourceRow(row, candidate)) return false;
            if (hasStrongSourceIdentityMatch(row, candidate)) return true;
            return catalog.filter((entry) => sameSourceRow(entry, candidate)).length === 1;
          });
          if (jobRow?.jobId) claimedJobIds.add(jobRow.jobId);
          return jobRow
            ? { ...row, jobId: jobRow.jobId, batchId: jobRow.batchId }
            : row;
        });
        return {
          ...current,
          uploadedSources: [
            ...catalogRows,
            ...current.uploadedSources.filter((row) => !isSourceRowReady(row)),
          ],
        };
      });
    } finally {
      if (request === sourceCatalogRequest.current) {
        setState((current) => current.scopeId === scopeId
          ? { ...current, sourcesLoading: false }
          : current);
      }
    }
  }, [scopeId, sessionId, topic]);

  const renameUploadedSourceRow = useCallback(
    (row: SourceRow, title: string) => {
      setState((current) => current.scopeId === scopeId
        ? {
            ...current,
            uploadedSources: current.uploadedSources.map((existing) =>
              sameSourceRow(existing, row)
                ? { ...existing, filename: title, timestamp: Date.now() }
                : existing),
          }
        : current);
      void refreshSourceCatalog();
    },
    [refreshSourceCatalog, scopeId],
  );

  const removeUploadedSourceRow = useCallback(
    (row: SourceRow) => {
      if (row.jobId && jobState.current.scopeId === scopeId) {
        jobState.current.dismissedIds.add(row.jobId);
        jobState.current.jobs = jobState.current.jobs.filter(
          (job) => job.job_id !== row.jobId,
        );
      }
      setState((current) => {
        if (current.scopeId !== scopeId) return current;
        return {
          ...current,
          uploadedSources: current.uploadedSources.filter(
            (existing) => !sameSourceRow(existing, row),
          ),
          selectedSourceIds: row.sourceId
            ? current.selectedSourceIds.filter((id) => id !== row.sourceId)
            : current.selectedSourceIds,
          hasActiveImportJobs: jobState.current.jobs.some(
            (job) => job.status === "queued" || job.status === "running",
          ),
        };
      });
      void refreshSourceCatalog();
    },
    [refreshSourceCatalog, scopeId],
  );

  const applySourceImportJobs = useCallback(
    (jobs: SkillActionJob[], includeSucceededRows = true) => {
      if (jobState.current.scopeId !== scopeId) return;
      const sourceJobs = jobs.filter((job) =>
        job.session_id === scopeId
        && job.action_id === SOURCE_IMPORT_ACTION_ID
        && !jobState.current.dismissedIds.has(job.job_id));
      if (sourceJobs.length === 0) return;

      const previousJobs = jobState.current.jobs;
      const mergedJobs = mergeSourceImportJobs(previousJobs, sourceJobs);
      jobState.current.jobs = mergedJobs;

      const acceptedSucceededJobs = sourceJobs.filter((job) => {
        if (job.status !== "succeeded") return false;
        const accepted = mergedJobs.find((candidate) => candidate.job_id === job.job_id);
        if (accepted?.status !== "succeeded"
          || (accepted.updated_at || accepted.created_at)
            !== (job.updated_at || job.created_at)) return false;
        const previous = previousJobs.find((candidate) => candidate.job_id === job.job_id);
        return previous?.status !== "succeeded"
          || (accepted.updated_at || accepted.created_at)
            !== (previous?.updated_at || previous?.created_at);
      });
      const transientRows = mergedJobs
        .filter((job) => job.status !== "succeeded")
        .map((job) => sourceRowFromSkillActionJob(job));
      const newlyReadyRows = includeSucceededRows
        ? acceptedSucceededJobs.map((job) => sourceRowFromSkillActionJob(job))
        : [];
      const succeededIds = new Set(
        acceptedSucceededJobs.map((job) => job.job_id),
      );
      setState((current) => current.scopeId === scopeId
        ? {
            ...current,
            uploadedSources: mergeSourceRows(
              current.uploadedSources.filter(
                (row) => !row.jobId || !succeededIds.has(row.jobId),
              ),
              [...transientRows, ...newlyReadyRows],
            ),
            hasActiveImportJobs: mergedJobs.some(
              (job) => job.status === "queued" || job.status === "running",
            ),
          }
        : current);
      if (acceptedSucceededJobs.length > 0) void refreshSourceCatalog();
    },
    [refreshSourceCatalog, scopeId],
  );

  const restoreSourceImportJobs = useCallback(async () => {
    const request = sourceCapabilityRequest.current;
    try {
      const jobs = await listSkillActionJobs(
        sessionId,
        { actionId: SOURCE_IMPORT_ACTION_ID },
        topic,
      );
      if (request !== sourceCapabilityRequest.current) return;
      // Persisted completed imports are history, not catalog membership.
      // Keep them for identity reconciliation, but only source.list may make
      // a restored succeeded job visible; otherwise source.remove would be
      // undone after every reconnect.
      applySourceImportJobs(jobs, false);
    } catch {
      // Initial bridge connection can race this restore; bridge_connected retries it.
    }
  }, [applySourceImportJobs, sessionId, topic]);

  useEffect(() => {
    if (sourcesCapability.status !== "supported") return;
    // Capability discovery owns reconnect handling. Re-entering the
    // supported state after a fresh scoped action/list response triggers
    // these reads, so no source RPC can race ahead of re-negotiation.
    void Promise.resolve().then(restoreSourceImportJobs);
    void Promise.resolve().then(refreshSourceCatalog).catch(() => {});
  }, [refreshSourceCatalog, restoreSourceImportJobs, sourcesCapability.status]);

  useEffect(() => {
    if (sourcesCapability.status !== "supported" || !hasActiveImportJobs) return;
    const poll = window.setInterval(() => void restoreSourceImportJobs(), 3_000);
    return () => window.clearInterval(poll);
  }, [hasActiveImportJobs, restoreSourceImportJobs, sourcesCapability.status]);

  useEffect(() => {
    if (sourcesCapability.status !== "supported") return;
    const onJobUpdated = (event: Event) => {
      const job = (event as CustomEvent<SkillActionJob>).detail;
      if (job) applySourceImportJobs([job]);
    };
    window.addEventListener("crew:skill_action_job_updated", onJobUpdated);
    return () => {
      window.removeEventListener("crew:skill_action_job_updated", onJobUpdated);
    };
  }, [applySourceImportJobs, sourcesCapability.status]);

  const toggleSource = useCallback((sourceId: string) => {
    setState((current) => current.scopeId === scopeId
      ? {
          ...current,
          selectedSourceIds: current.selectedSourceIds.includes(sourceId)
            ? current.selectedSourceIds.filter((id) => id !== sourceId)
            : [...current.selectedSourceIds, sourceId],
        }
      : current);
  }, [scopeId]);

  const refreshSourceCatalogSafely = useCallback(() => {
    void refreshSourceCatalog().catch(() => {});
  }, [refreshSourceCatalog]);

  return {
    selectedSources,
    uploadedSources,
    sourcesLoading,
    sourcesCapability,
    selectedSourceIds,
    toggleSource,
    mergeUploadedSourceRows,
    renameUploadedSourceRow,
    removeUploadedSourceRow,
    refreshSourceCatalog: refreshSourceCatalogSafely,
  };
}
