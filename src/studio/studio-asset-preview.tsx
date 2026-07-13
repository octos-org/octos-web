import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Download, FileText } from "lucide-react";

import type { AssetFile, StudioAsset } from "./generated-assets";
import { AuthenticatedTextFile } from "./authenticated-text-file";
import { StudioFilePreview } from "./studio-file-preview";
import { FlashcardsViewer, QuizViewer, ReportViewer } from "./study-asset-viewers";
import {
  DataTableViewer,
  MindMapViewer,
  VideoScenesViewer,
  type CitationTarget,
} from "./structured-asset-viewers";
import { usePreviewEscape } from "./use-preview-escape";

interface Props {
  asset: StudioAsset;
  sessionId: string;
  downloadError?: string | null;
  onBack: () => void;
  onDownload: (file: AssetFile) => void;
  onCitationOpen?: (citation: CitationTarget) => void;
}

type VideoTab = "overview" | "script" | "scenes" | "assets" | "files";
type GenericTab = "preview" | "files";

const VIDEO_TABS: Array<{ id: VideoTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "script", label: "Script" },
  { id: "scenes", label: "Scenes" },
  { id: "assets", label: "Assets" },
  { id: "files", label: "Files" },
];

const GENERIC_TABS: Array<{ id: GenericTab; label: string }> = [
  { id: "preview", label: "Preview" },
  { id: "files", label: "Files" },
];

function statusLabel(asset: StudioAsset): string {
  switch (asset.status) {
    case "generating":
      return "Generating";
    case "ready":
      return "Ready";
    case "partial":
      return "Partially ready";
    case "failed":
      return "Failed";
    case "unavailable":
      return "Unavailable";
  }
}

function FilePreview({
  file,
  sessionId,
  empty,
}: {
  file?: AssetFile;
  sessionId: string;
  empty: ReactNode;
}) {
  if (!file) {
    return (
      <div className="studio-empty-state m-4 text-xs">
        {empty}
      </div>
    );
  }
  return (
    <StudioFilePreview
      filename={file.filename}
      filePath={file.filePath}
      mediaType={file.mediaType}
      size={file.size}
      sessionId={sessionId}
      kind="asset"
    />
  );
}

function FilesView({
  files,
  onDownload,
  sessionId,
}: {
  files: AssetFile[];
  onDownload: (file: AssetFile) => void;
  sessionId: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreFocusId, setRestoreFocusId] = useState<string | null>(null);
  const fileTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const selected = selectedId
    ? files.find((file) => file.id === selectedId) ?? null
    : null;
  useEffect(() => {
    if (selected || !restoreFocusId) return;
    const trigger = fileTriggerRefs.current.get(restoreFocusId);
    if (trigger) {
      trigger.focus();
      setRestoreFocusId(null);
    }
  }, [restoreFocusId, selected]);
  if (files.length === 0) {
    return <div className="studio-empty-state m-4 text-xs">No files are ready yet.</div>;
  }
  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b p-2">
          <button
            type="button"
            autoFocus
            className="studio-ghost-button px-2 py-1.5 text-xs"
            onClick={() => {
              setRestoreFocusId(selected.id);
              setSelectedId(null);
            }}
          >
            Back to files
          </button>
          <span className="min-w-0 flex-1 truncate text-xs" title={selected.filename}>{selected.filename}</span>
          <button type="button" className="studio-ghost-button p-1.5" aria-label={`Download ${selected.filename}`} onClick={() => onDownload(selected)}><Download size={14} /></button>
        </div>
        <StudioFilePreview filename={selected.filename} filePath={selected.filePath} mediaType={selected.mediaType} size={selected.size} sessionId={sessionId} kind="asset" />
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2 overflow-y-auto p-4">
      {files.map((file) => (
        <li key={file.id} className="studio-list-row studio-card !rounded-xl p-3">
          <FileText size={16} className="shrink-0 text-muted" />
          <button
            ref={(node) => {
              if (node) fileTriggerRefs.current.set(file.id, node);
              else fileTriggerRefs.current.delete(file.id);
            }}
            type="button"
            className="min-w-0 flex-1 text-left"
            aria-label={`Open file ${file.filename}`}
            onClick={() => setSelectedId(file.id)}
          >
            <span className="block truncate text-sm" title={file.filename}>
              {file.filename}
            </span>
            <span className="mt-0.5 block text-[11px] capitalize text-muted">
              {file.role.replaceAll("-", " ")}
            </span>
          </button>
          <button
            type="button"
            className="studio-ghost-button studio-asset-action shrink-0 p-1"
            aria-label={`Download ${file.filename}`}
            onClick={() => onDownload(file)}
          >
            <Download size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function TabStrip<T extends string>({
  tabs,
  selected,
  onSelect,
  panelId,
}: {
  tabs: Array<{ id: T; label: string }>;
  selected: T;
  onSelect: (tab: T) => void;
  panelId: string;
}) {
  return (
    <div className="flex shrink-0 overflow-x-auto border-b px-2" role="tablist">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`${panelId}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={selected === tab.id}
          aria-controls={panelId}
          tabIndex={selected === tab.id ? 0 : -1}
          className={`shrink-0 border-b-2 px-3 py-2 text-xs ${selected === tab.id ? "border-accent text-text-strong" : "border-transparent text-muted"}`}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const nextIndex = (index + direction + tabs.length) % tabs.length;
            onSelect(tabs[nextIndex].id);
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
              ?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function VideoOverviewBody({
  asset,
  sessionId,
  onDownload,
  onCitationOpen,
}: Omit<Props, "onBack">) {
  const [tab, setTab] = useState<VideoTab>("overview");
  const fileByRole = (role: string) => asset.files.find((file) => file.role === role);

  return (
    <>
      <TabStrip tabs={VIDEO_TABS} selected={tab} onSelect={setTab} panelId="studio-video-asset-panel" />
      <div id="studio-video-asset-panel" role="tabpanel" aria-labelledby={`studio-video-asset-panel-tab-${tab}`} className="min-h-0 flex-1 overflow-hidden">
        {tab === "overview" && (
          <FilePreview
            file={fileByRole("video")}
            sessionId={sessionId}
            empty="Video rendering unavailable. Plan files are ready."
          />
        )}
        {tab === "script" && (
          <FilePreview
            file={fileByRole("script")}
            sessionId={sessionId}
            empty="No script file is available."
          />
        )}
        {tab === "scenes" && (
          <AuthenticatedTextFile
            file={fileByRole("scene-plan")}
            sessionId={sessionId}
            empty="No scene plan is available."
          >
            {(text) => <VideoScenesViewer text={text} onCitationOpen={onCitationOpen} />}
          </AuthenticatedTextFile>
        )}
        {tab === "assets" && (
          <FilePreview
            file={fileByRole("asset-brief")}
            sessionId={sessionId}
            empty="No asset brief is available."
          />
        )}
        {tab === "files" && (
          <FilesView files={asset.files} onDownload={onDownload} sessionId={sessionId} />
        )}
      </div>
    </>
  );
}

function GenericAssetBody({
  asset,
  sessionId,
  onDownload,
}: Omit<Props, "onBack">) {
  const [tab, setTab] = useState<GenericTab>("preview");
  return (
    <>
      <TabStrip tabs={GENERIC_TABS} selected={tab} onSelect={setTab} panelId="studio-generic-asset-panel" />
      <div id="studio-generic-asset-panel" role="tabpanel" aria-labelledby={`studio-generic-asset-panel-tab-${tab}`} className="min-h-0 flex-1 overflow-hidden">
        {tab === "preview" ? (
          <FilePreview
            file={asset.primary}
            sessionId={sessionId}
            empty="This asset does not have a previewable file yet."
          />
        ) : (
          <FilesView files={asset.files} onDownload={onDownload} sessionId={sessionId} />
        )}
      </div>
    </>
  );
}

function StudyAssetBody({
  asset,
  sessionId,
  onDownload,
}: Omit<Props, "onBack">) {
  const [tab, setTab] = useState<GenericTab>("preview");
  return (
    <>
      <TabStrip tabs={GENERIC_TABS} selected={tab} onSelect={setTab} panelId="studio-study-asset-panel" />
      <div id="studio-study-asset-panel" role="tabpanel" aria-labelledby={`studio-study-asset-panel-tab-${tab}`} className="min-h-0 flex-1 overflow-hidden">
        {tab === "files" ? (
          <FilesView files={asset.files} onDownload={onDownload} sessionId={sessionId} />
        ) : (
          <AuthenticatedTextFile
            file={asset.primary}
            sessionId={sessionId}
            empty="This asset does not have an interactive document yet."
          >
            {(text) => asset.kind === "quiz"
              ? <QuizViewer text={text} />
              : asset.kind === "flashcards"
                ? <FlashcardsViewer text={text} />
                : <ReportViewer text={text} />}
          </AuthenticatedTextFile>
        )}
      </div>
    </>
  );
}

function StructuredAssetBody({
  asset,
  sessionId,
  onDownload,
  onCitationOpen,
}: Omit<Props, "onBack">) {
  const [tab, setTab] = useState<GenericTab>("preview");
  return (
    <>
      <TabStrip tabs={GENERIC_TABS} selected={tab} onSelect={setTab} panelId="studio-structured-asset-panel" />
      <div id="studio-structured-asset-panel" role="tabpanel" aria-labelledby={`studio-structured-asset-panel-tab-${tab}`} className="min-h-0 flex-1 overflow-hidden">
        {tab === "files" ? (
          <FilesView files={asset.files} onDownload={onDownload} sessionId={sessionId} />
        ) : (
          <AuthenticatedTextFile
            file={asset.primary}
            sessionId={sessionId}
            empty="The canonical structured file is unavailable."
          >
            {(text) => asset.kind === "mind-map"
              ? <MindMapViewer text={text} onCitationOpen={onCitationOpen} />
              : <DataTableViewer text={text} onCitationOpen={onCitationOpen} />}
          </AuthenticatedTextFile>
        )}
      </div>
    </>
  );
}

export function StudioAssetPreview({
  asset,
  sessionId,
  downloadError,
  onBack,
  onDownload,
  onCitationOpen,
}: Props) {
  const { activate } = usePreviewEscape(onBack);

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
          aria-label="Back to Studio"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={asset.title}>
            {asset.title}
          </p>
          <p className="text-[11px] text-muted">{statusLabel(asset)}</p>
        </div>
      </div>
      {downloadError && (
        <p className="shrink-0 px-3 py-2 text-xs text-red-500" role="alert">
          {downloadError}
        </p>
      )}
      {asset.statusReason && (
        <p className="shrink-0 border-b px-3 py-2 text-xs text-muted">
          {asset.statusReason}
        </p>
      )}
      {asset.kind === "video-overview" ? (
        <VideoOverviewBody
          asset={asset}
          sessionId={sessionId}
          onDownload={onDownload}
          onCitationOpen={onCitationOpen}
        />
      ) : ["report", "quiz", "flashcards"].includes(asset.kind) ? (
        <StudyAssetBody
          asset={asset}
          sessionId={sessionId}
          onDownload={onDownload}
        />
      ) : ["mind-map", "data-table"].includes(asset.kind) ? (
        <StructuredAssetBody
          asset={asset}
          sessionId={sessionId}
          onDownload={onDownload}
          onCitationOpen={onCitationOpen}
        />
      ) : (
        <GenericAssetBody
          asset={asset}
          sessionId={sessionId}
          onDownload={onDownload}
        />
      )}
    </div>
  );
}
