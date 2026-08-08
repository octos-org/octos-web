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
  mergeSourceRows,
  sourceRowFromSkillActionJob,
  type SourceRow,
} from "./source-media";
import { loadSourceCatalog } from "./source-store";

interface SourceState {
  sessionId: string;
  selectedSources: string[];
  uploadedSources: SourceRow[];
  sourcesLoading: boolean;
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

function initialSourceState(sessionId: string): SourceState {
  return {
    sessionId,
    selectedSources: [],
    uploadedSources: [],
    sourcesLoading: true,
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

function sameSourceRow(a: SourceRow, b: SourceRow): boolean {
  if (a.jobId && b.jobId && a.jobId === b.jobId) return true;
  if (a.sourceId && b.sourceId && a.sourceId === b.sourceId) return true;
  return a.path === b.path;
}

function selectedPathMatchesRow(path: string, row: SourceRow): boolean {
  return path === row.path || path === row.sourcePath;
}

/**
 * Owns the notebook source catalog, transient import jobs, and selection for
 * one session. Both /studio and the opt-in Workspace chat shell use this
 * controller so they cannot drift back to different source lifecycles.
 */
export function useNotebookSources(sessionId: string, topic?: string) {
  const scopeId = skillActionScopeId(sessionId, topic);
  const [state, setState] = useState<SourceState>(() =>
    initialSourceState(scopeId),
  );
  const sourceCapabilityRequest = useRef(0);
  const sourceCatalogRequest = useRef(0);
  const terminalImportJobs = useRef<{
    scopeId: string;
    ids: Set<string>;
  }>({ scopeId, ids: new Set() });

  const sourcesCapability =
    state.sessionId === scopeId
      ? state.sourcesCapability
      : initialSourceState(scopeId).sourcesCapability;
  const capabilitySupported = sourcesCapability.status === "supported";
  const selectedSources =
    state.sessionId === scopeId && capabilitySupported
      ? state.selectedSources
      : [];
  const uploadedSources =
    state.sessionId === scopeId && capabilitySupported
      ? state.uploadedSources
      : [];
  const sourcesLoading =
    state.sessionId === scopeId ? state.sourcesLoading : true;

  useEffect(() => {
    let cancelled = false;
    const refreshCapabilities = () => {
      const request = ++sourceCapabilityRequest.current;
      sourceCatalogRequest.current += 1;
      if (terminalImportJobs.current.scopeId !== scopeId) {
        terminalImportJobs.current = { scopeId, ids: new Set() };
      }
      setState((current) =>
        ({
          ...(current.sessionId === scopeId
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
            current.sessionId === scopeId
              ? {
                  ...current,
                  selectedSources: unsupported ? [] : current.selectedSources,
                  uploadedSources: unsupported ? [] : current.uploadedSources,
                  sourcesLoading: unsupported ? false : current.sourcesLoading,
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
            current.sessionId === scopeId
              ? {
                  ...current,
                  selectedSources: [],
                  uploadedSources: [],
                  sourcesLoading: false,
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
      setState((current) =>
        current.sessionId === scopeId
          ? {
              ...current,
              uploadedSources: mergeSourceRows(current.uploadedSources, rows),
            }
          : current,
      );
    },
    [scopeId],
  );

  const refreshSourceCatalog = useCallback(async () => {
    const request = ++sourceCatalogRequest.current;
    try {
      const catalog = await loadSourceCatalog(sessionId, topic);
      if (request !== sourceCatalogRequest.current) return;
      setState((current) =>
        current.sessionId === scopeId
          ? {
              ...current,
              uploadedSources: [
                ...catalog,
                ...current.uploadedSources.filter(
                  (row) => (row.status ?? "ready") !== "ready",
                ),
              ],
            }
          : current,
      );
    } finally {
      if (request === sourceCatalogRequest.current) {
        setState((current) =>
          current.sessionId === scopeId
            ? { ...current, sourcesLoading: false }
            : current,
        );
      }
    }
  }, [scopeId, sessionId, topic]);

  const renameUploadedSourceRow = useCallback(
    (row: SourceRow, title: string) => {
      setState((current) =>
        current.sessionId === scopeId
          ? {
              ...current,
              uploadedSources: current.uploadedSources.map((existing) =>
                sameSourceRow(existing, row)
                  ? { ...existing, filename: title, timestamp: Date.now() }
                  : existing,
              ),
            }
          : current,
      );
    },
    [scopeId],
  );

  const removeUploadedSourceRow = useCallback(
    (row: SourceRow) => {
      setState((current) =>
        current.sessionId === scopeId
          ? {
              ...current,
              uploadedSources: current.uploadedSources.filter(
                (existing) => !sameSourceRow(existing, row),
              ),
              selectedSources: current.selectedSources.filter(
                (path) => !selectedPathMatchesRow(path, row),
              ),
            }
          : current,
      );
    },
    [scopeId],
  );

  const mergeSourceImportJobs = useCallback(
    (jobs: SkillActionJob[]) => {
      if (terminalImportJobs.current.scopeId !== scopeId) return;
      const sourceJobsForScope = jobs.filter(
        (job) =>
          job.session_id === scopeId &&
          job.action_id === SOURCE_IMPORT_ACTION_ID,
      );
      const terminalIds = terminalImportJobs.current.ids;
      for (const job of sourceJobsForScope) {
        if (
          job.status === "succeeded" ||
          job.status === "failed" ||
          job.status === "cancelled" ||
          job.status === "abandoned"
        ) {
          terminalIds.add(job.job_id);
        }
      }
      // A persisted job/list response can arrive after the live terminal
      // event. Never resurrect queued/running rows once that job reached a
      // terminal state.
      const sourceJobs = sourceJobsForScope.filter(
        (job) =>
          !terminalIds.has(job.job_id) ||
          (job.status !== "queued" && job.status !== "running"),
      );
      if (sourceJobs.length === 0) return;

      const succeededIds = new Set(
        sourceJobs
          .filter((job) => job.status === "succeeded")
          .map((job) => job.job_id),
      );
      const transientRows = sourceJobs
        .filter((job) => job.status !== "succeeded")
        .map((job) => sourceRowFromSkillActionJob(job));
      setState((current) =>
        current.sessionId === scopeId
          ? {
              ...current,
              uploadedSources: mergeSourceRows(
                current.uploadedSources.filter(
                  (row) => !row.jobId || !succeededIds.has(row.jobId),
                ),
                transientRows,
              ),
            }
          : current,
      );
      if (succeededIds.size > 0) {
        void refreshSourceCatalog().catch(() => {});
      }
    },
    [refreshSourceCatalog, scopeId],
  );

  const restoreSourceImportJobs = useCallback(async () => {
    const request = sourceCapabilityRequest.current;
    try {
      const jobs = await listSkillActionJobs(
        sessionId,
        {
          actionId: SOURCE_IMPORT_ACTION_ID,
        },
        topic,
      );
      if (request !== sourceCapabilityRequest.current) return;
      mergeSourceImportJobs(jobs);
    } catch {
      // The bridge may not be connected yet; bridge_connected retries it.
    }
  }, [mergeSourceImportJobs, sessionId, topic]);

  useEffect(() => {
    if (sourcesCapability.status !== "supported") return;
    // Capability discovery owns reconnect handling. Re-entering the
    // supported state after a fresh scoped action/list response triggers
    // these reads, so no source RPC can race ahead of re-negotiation.
    void Promise.resolve().then(restoreSourceImportJobs);
    void Promise.resolve().then(refreshSourceCatalog).catch(() => {});
  }, [refreshSourceCatalog, restoreSourceImportJobs, sourcesCapability.status]);

  useEffect(() => {
    if (sourcesCapability.status !== "supported") return;
    const onJobUpdated = (event: Event) => {
      const job = (event as CustomEvent<SkillActionJob>).detail;
      if (job) mergeSourceImportJobs([job]);
    };
    window.addEventListener("crew:skill_action_job_updated", onJobUpdated);
    return () => {
      window.removeEventListener("crew:skill_action_job_updated", onJobUpdated);
    };
  }, [mergeSourceImportJobs, sourcesCapability.status]);

  const toggleSource = useCallback(
    (path: string) => {
      setState((current) =>
        current.sessionId === scopeId
          ? {
              ...current,
              selectedSources: current.selectedSources.includes(path)
                ? current.selectedSources.filter((entry) => entry !== path)
                : [...current.selectedSources, path],
            }
          : current,
      );
    },
    [scopeId],
  );

  const selectedSourceIds = selectedSources
    .map(
      (path) =>
        uploadedSources.find(
          (row) => row.sourceId && selectedPathMatchesRow(path, row),
        )?.sourceId,
    )
    .filter((sourceId): sourceId is string => Boolean(sourceId));

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
