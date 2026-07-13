import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Download, Info } from "lucide-react";

import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";

import { isSourceRowReady, sourcePreviewPath, type SourceRow } from "./source-media";
import { isFilePreviewable } from "./file-preview-mode";
import { StudioFilePreview } from "./studio-file-preview";
import { downloadStudioFile } from "./studio-file-download";
import type { CitationTarget } from "./structured-asset-viewers";
import { usePreviewEscape } from "./use-preview-escape";

interface Props {
  row: SourceRow;
  sessionId: string;
  onBack: () => void;
  citationTarget?: CitationTarget | null;
}
type SourcePreviewTab = "original" | "parsed" | "guide";

function isSafeWorkspacePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return Boolean(normalized)
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

function provenanceLabel(provenance?: Record<string, unknown>): string | null {
  if (!provenance || Object.keys(provenance).length === 0) return null;
  return Object.entries(provenance)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key.replaceAll("_", " ")}: ${String(value)}`)
    .join(" · ");
}

export function StudioSourcePreview({ row, sessionId, onBack, citationTarget }: Props) {
  const { activate } = usePreviewEscape(onBack);
  const originalPath = sourcePreviewPath(row);
  const parsedPath = row.sourcePath ?? row.path;
  const parsedAvailable = Boolean(row.sourcePath)
    || (isSourceRowReady(row)
      && originalPath.replaceAll("\\", "/") !== row.path.replaceAll("\\", "/"));
  const originalAvailable = Boolean(originalPath) && (
    !parsedAvailable
    || originalPath.replaceAll("\\", "/") !== parsedPath.replaceAll("\\", "/")
  );
  const originalFilename = row.originalFilename ?? row.filename;
  const originalPreviewable = originalAvailable
    && isFilePreviewable(originalFilename, row.mediaType);
  const originalDownloadPath = row.materializedPath ?? row.inputPath ?? originalPath;
  const citationMatches = Boolean(citationTarget && (
    (citationTarget.sourceId && citationTarget.sourceId === row.sourceId)
    || (citationTarget.sourcePath && citationTarget.sourcePath === row.sourcePath)
  ));
  const rowIdentity = row.sourceId ?? row.sourcePath ?? row.path;
  const viewKey = citationMatches && citationTarget
    ? `${rowIdentity}::citation:${citationTarget.chunkId}:${citationTarget.startLine ?? ""}:${citationTarget.endLine ?? ""}`
    : rowIdentity;
  const initialTab: SourcePreviewTab = citationMatches && parsedAvailable
    ? "parsed"
    : originalPreviewable || !parsedAvailable
      ? "original"
      : "parsed";
  const [viewState, setViewState] = useState<{
    key: string;
    tab: SourcePreviewTab;
    summaryPath: string | null;
    guideResolved: boolean;
    guideError: string | null;
    downloadError: string | null;
  }>({
    key: viewKey,
    tab: initialTab,
    summaryPath: row.summaryPath ?? null,
    guideResolved: Boolean(row.summaryPath),
    guideError: null,
    downloadError: null,
  });
  const current = viewState.key === viewKey
    ? viewState
    : {
        key: viewKey,
        tab: initialTab,
        summaryPath: row.summaryPath ?? null,
        guideResolved: Boolean(row.summaryPath),
        guideError: null,
        downloadError: null,
      };
  const { tab, summaryPath, guideResolved, guideError, downloadError } = current;
  const setTab = (nextTab: SourcePreviewTab) => {
    setViewState((previous) => ({
      ...(previous.key === viewKey ? previous : current),
      tab: nextTab,
    }));
  };
  const provenance = provenanceLabel(row.provenance);
  const downloadRequestId = useRef(0);

  useEffect(() => {
    downloadRequestId.current += 1;
  }, [viewKey]);

  useEffect(() => {
    if (tab !== "guide" || guideResolved || summaryPath || !row.metadataPath) return;
    const controller = new AbortController();
    void fetch(buildFileUrl(row.metadataPath, {
      sessionId,
      workspaceScoped: true,
    }), {
      headers: buildApiHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Source Guide metadata failed (${response.status})`);
        const metadata = await response.json() as { summary_path?: unknown };
        const path = typeof metadata.summary_path === "string"
          && isSafeWorkspacePath(metadata.summary_path)
          ? metadata.summary_path
          : null;
        if (!controller.signal.aborted) {
          setViewState((previous) => previous.key === viewKey
            ? {
                ...previous,
                summaryPath: path,
                guideResolved: true,
                guideError: null,
              }
            : previous);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setViewState((previous) => previous.key === viewKey
            ? {
                ...previous,
                guideResolved: true,
                guideError: reason instanceof Error ? reason.message : "Source Guide unavailable",
              }
            : previous);
        }
      });
    return () => controller.abort();
  }, [guideResolved, row.metadataPath, sessionId, summaryPath, tab, viewKey]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onFocusCapture={activate}
      onPointerDownCapture={activate}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-3">
        <button
          type="button"
          autoFocus
          className="studio-ghost-button shrink-0 p-1.5"
          aria-label="Back to sources"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={row.filename}>
            {row.filename}
          </p>
          <p className="text-[11px] text-muted">Source preview</p>
        </div>
        {originalAvailable && (
          <button
            type="button"
            className="studio-ghost-button shrink-0 p-1.5"
            aria-label={`Download original ${row.filename}`}
            onClick={() => {
              const requestId = ++downloadRequestId.current;
              setViewState((previous) => ({
                ...(previous.key === viewKey ? previous : current),
                downloadError: null,
              }));
              void downloadStudioFile(originalDownloadPath, originalFilename, sessionId)
                .catch((reason: unknown) => setViewState((previous) => (
                  previous.key === viewKey && downloadRequestId.current === requestId
                    ? {
                        ...previous,
                        downloadError: reason instanceof Error
                          ? reason.message
                          : "Download failed",
                      }
                    : previous
                )));
            }}
          >
            <Download size={15} />
          </button>
        )}
      </div>
      {downloadError && <p className="shrink-0 px-3 py-2 text-xs text-red-500" role="alert">{downloadError}</p>}
      <div
        className="flex shrink-0 border-b px-2"
        role="tablist"
        aria-label="Source preview"
      >
        {(["original", "parsed", "guide"] as const).map((value, index, tabs) => (
          <button
            key={value}
            id={`studio-source-preview-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls="studio-source-preview-panel"
            tabIndex={tab === value ? 0 : -1}
            className={`border-b-2 px-3 py-2 text-xs ${tab === value ? "border-accent text-text-strong" : "border-transparent text-muted"}`}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const direction = event.key === "ArrowRight" ? 1 : -1;
              const nextIndex = (index + direction + tabs.length) % tabs.length;
              setTab(tabs[nextIndex]);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
                ?.focus();
            }}
          >
            {value === "original"
              ? "Original"
              : value === "parsed"
                ? "Parsed"
                : "Source Guide"}
          </button>
        ))}
      </div>
      <div
        id="studio-source-preview-panel"
        role="tabpanel"
        aria-labelledby={`studio-source-preview-tab-${tab}`}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {tab === "original" ? (
          originalPreviewable ? (
            <StudioFilePreview
              filename={originalFilename}
              filePath={originalPath}
              mediaType={row.mediaType}
              sessionId={sessionId}
              kind="source"
              fallbackAction={parsedAvailable
                ? { label: "View parsed content", onClick: () => setTab("parsed") }
                : undefined}
            />
          ) : (
            <div className="studio-empty-state m-4 text-xs">
              <p>{originalAvailable
                ? "The original file cannot be shown safely in the browser."
                : "The original file is unavailable."}</p>
              {parsedAvailable && (
                <button
                  type="button"
                  className="studio-button-primary mt-3 h-8 px-3 text-xs"
                  onClick={() => setTab("parsed")}
                >
                  View parsed content
                </button>
              )}
            </div>
          )
        ) : tab === "parsed" && parsedAvailable ? (
          <StudioFilePreview
            filename={`${row.filename} parsed.md`}
            filePath={parsedPath}
            mediaType="text/markdown"
            sessionId={sessionId}
            kind="source"
            lineRange={citationMatches && citationTarget?.startLine !== undefined
              ? { start: citationTarget.startLine, end: citationTarget.endLine ?? citationTarget.startLine }
              : undefined}
          />
        ) : tab === "parsed" ? (
          <div className="studio-empty-state m-4 text-xs">
            Parsed content is not available yet.
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
            {row.warnings && row.warnings.length > 0 && (
              <section className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-amber-600">
                  <AlertTriangle size={14} /> Import warnings
                </h3>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
                  {row.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </section>
            )}
            {provenance && (
              <p className="mb-4 flex items-start gap-2 text-[11px] text-muted">
                <Info size={13} className="mt-0.5 shrink-0" />
                <span>{provenance}</span>
              </p>
            )}
            <div className="min-h-[12rem] flex-1 overflow-hidden rounded-xl border">
              {summaryPath ? (
                <StudioFilePreview
                  filename={`${row.filename} summary.md`}
                  filePath={summaryPath}
                  mediaType="text/markdown"
                  sessionId={sessionId}
                  kind="source"
                />
              ) : !guideResolved && row.metadataPath ? (
                <div className="studio-empty-state m-4 text-xs" role="status">
                  Loading Source Guide…
                </div>
              ) : (
                <div className="studio-empty-state m-4 text-xs">
                  {guideError ?? "No generated summary is available for this source."}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
