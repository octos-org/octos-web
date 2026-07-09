import { ExternalLink, X } from "lucide-react";

import { buildAuthenticatedFileUrl } from "@/api/files";

type PreviewMode = "image" | "audio" | "video" | "pdf" | "text" | "unsupported";

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function previewMode(filename: string): PreviewMode {
  const ext = extensionOf(filename);
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown", "txt", "csv", "json"].includes(ext)) return "text";
  return "unsupported";
}

interface Props {
  filename: string;
  filePath: string;
  sessionId: string;
  kind: "source" | "asset";
  onClose: () => void;
}

export function StudioFilePreviewDialog({
  filename,
  filePath,
  sessionId,
  kind,
  onClose,
}: Props) {
  const url = buildAuthenticatedFileUrl(filePath, { sessionId });
  const mode = previewMode(filename);
  const label = `${filename} ${kind} preview`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="studio-pane flex h-[min(760px,90vh)] w-[min(920px,92vw)] flex-col overflow-hidden border shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <h3 className="min-w-0 truncate text-sm font-medium">{filename}</h3>
          <button
            type="button"
            className="studio-ghost-button p-2"
            aria-label={`Close ${kind} preview`}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface/40 p-4">
          {mode === "image" && <img src={url} alt={label} className="max-h-full max-w-full rounded-[8px] object-contain" />}
          {mode === "audio" && <audio src={url} controls className="w-full max-w-xl" />}
          {mode === "video" && <video src={url} controls className="max-h-full max-w-full rounded-[8px]" />}
          {(mode === "pdf" || mode === "text") && <iframe title={label} src={url} className="h-full w-full rounded-[8px] border bg-white" />}
          {mode === "unsupported" && (
            <a href={url} target="_blank" rel="noreferrer" className="studio-button-primary h-9 px-3 text-sm">
              <ExternalLink size={15} />
              Open file
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
