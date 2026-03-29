import { Loader2, Download, CheckCircle, AlertCircle, FileText, Headphones, Presentation } from "lucide-react";
import type { StudioOutput, OutputType } from "../types";

const typeIcons: Record<OutputType, typeof FileText> = {
  summary: FileText,
  report: FileText,
  podcast: Headphones,
  slides: Presentation,
  infographic: FileText,
  comic: FileText,
  website: FileText,
};

export function OutputCard({ output }: { output: StudioOutput }) {
  const Icon = typeIcons[output.type] || FileText;

  return (
    <div className="flex items-start gap-3 rounded-2xl bg-surface-container p-4 elevation-1">
      <div className="shrink-0 pt-0.5">
        {output.status === "generating" || output.status === "pending" ? (
          <Loader2 size={18} className="animate-spin text-accent" />
        ) : output.status === "error" ? (
          <AlertCircle size={18} className="text-red-400" />
        ) : (
          <CheckCircle size={18} className="text-green-400" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Icon size={14} className="shrink-0 text-muted" />
          <span className="truncate text-sm font-medium text-text-strong">
            {output.title}
          </span>
        </div>
        {output.status === "generating" && (
          <p className="mt-1 text-xs text-accent">Generating...</p>
        )}
        {output.status === "pending" && (
          <p className="mt-1 text-xs text-muted">Queued</p>
        )}
        {output.status === "error" && (
          <p className="mt-1 text-xs text-red-400">{output.error || "Generation failed"}</p>
        )}
        {output.status === "complete" && output.preview && (
          <p className="mt-1 line-clamp-2 text-xs text-muted">{output.preview}</p>
        )}
      </div>
      {output.status === "complete" && output.fileUrl && (
        <a
          href={output.fileUrl}
          download={output.filename}
          className="shrink-0 rounded-lg p-2 text-link hover:bg-link/10"
          title="Download"
        >
          <Download size={16} />
        </a>
      )}
    </div>
  );
}
