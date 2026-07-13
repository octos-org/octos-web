import { useState } from "react";
import { ArrowLeft } from "lucide-react";

import { sourcePreviewPath, type SourceRow } from "./source-media";
import { StudioFilePreview } from "./studio-file-preview";

interface Props {
  row: SourceRow;
  sessionId: string;
  onBack: () => void;
}
type SourcePreviewTab = "original" | "parsed";

export function StudioSourcePreview({ row, sessionId, onBack }: Props) {
  const [tab, setTab] = useState<SourcePreviewTab>("original");
  const parsedPath = row.sourcePath ?? row.path;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-3">
        <button
          type="button"
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
      </div>
      <div
        className="flex shrink-0 border-b px-2"
        role="tablist"
        aria-label="Source preview"
      >
        {(["original", "parsed"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`border-b-2 px-3 py-2 text-xs ${tab === value ? "border-accent text-text-strong" : "border-transparent text-muted"}`}
            onClick={() => setTab(value)}
          >
            {value === "original" ? "Original" : "Parsed"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "original" ? (
          <StudioFilePreview
            filename={row.filename}
            filePath={sourcePreviewPath(row)}
            mediaType={row.mediaType}
            sessionId={sessionId}
            kind="source"
          />
        ) : (
          <StudioFilePreview
            filename={`${row.filename} parsed.md`}
            filePath={parsedPath}
            mediaType="text/markdown"
            sessionId={sessionId}
            kind="source"
          />
        )}
      </div>
    </div>
  );
}
