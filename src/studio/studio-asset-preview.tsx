import { useState, type ReactNode } from "react";
import { ArrowLeft, Download, FileText } from "lucide-react";

import type { AssetFile, StudioAsset } from "./generated-assets";
import { StudioFilePreview } from "./studio-file-preview";

interface Props {
  asset: StudioAsset;
  sessionId: string;
  downloadError?: string | null;
  onBack: () => void;
  onDownload: (file: AssetFile) => void;
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
      sessionId={sessionId}
      kind="asset"
    />
  );
}

function FilesView({
  files,
  onDownload,
}: {
  files: AssetFile[];
  onDownload: (file: AssetFile) => void;
}) {
  if (files.length === 0) {
    return <div className="studio-empty-state m-4 text-xs">No files are ready yet.</div>;
  }
  return (
    <ul className="flex flex-col gap-2 overflow-y-auto p-4">
      {files.map((file) => (
        <li key={file.id} className="studio-list-row studio-card !rounded-xl p-3">
          <FileText size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm" title={file.filename}>
              {file.filename}
            </span>
            <span className="mt-0.5 block text-[11px] capitalize text-muted">
              {file.role.replaceAll("-", " ")}
            </span>
          </span>
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
}: {
  tabs: Array<{ id: T; label: string }>;
  selected: T;
  onSelect: (tab: T) => void;
}) {
  return (
    <div className="flex shrink-0 overflow-x-auto border-b px-2" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={selected === tab.id}
          className={`shrink-0 border-b-2 px-3 py-2 text-xs ${selected === tab.id ? "border-accent text-text-strong" : "border-transparent text-muted"}`}
          onClick={() => onSelect(tab.id)}
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
}: Omit<Props, "onBack">) {
  const [tab, setTab] = useState<VideoTab>("overview");
  const fileByRole = (role: string) => asset.files.find((file) => file.role === role);

  return (
    <>
      <TabStrip tabs={VIDEO_TABS} selected={tab} onSelect={setTab} />
      <div className="min-h-0 flex-1 overflow-hidden">
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
          <FilePreview
            file={fileByRole("scene-plan")}
            sessionId={sessionId}
            empty="No scene plan is available."
          />
        )}
        {tab === "assets" && (
          <FilePreview
            file={fileByRole("asset-brief")}
            sessionId={sessionId}
            empty="No asset brief is available."
          />
        )}
        {tab === "files" && (
          <FilesView files={asset.files} onDownload={onDownload} />
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
      <TabStrip tabs={GENERIC_TABS} selected={tab} onSelect={setTab} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "preview" ? (
          <FilePreview
            file={asset.primary}
            sessionId={sessionId}
            empty="This asset does not have a previewable file yet."
          />
        ) : (
          <FilesView files={asset.files} onDownload={onDownload} />
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
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-3">
        <button
          type="button"
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
      {asset.kind === "video-overview" ? (
        <VideoOverviewBody
          asset={asset}
          sessionId={sessionId}
          onDownload={onDownload}
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
