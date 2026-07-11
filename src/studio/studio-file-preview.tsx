import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";

import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";

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
  const previewKey = `${sessionId}\0${filePath}`;
  const [preview, setPreview] = useState<{
    key: string;
    url: string | null;
    error: string | null;
  }>({ key: previewKey, url: null, error: null });
  const url = preview.key === previewKey ? preview.url : null;
  const error = preview.key === previewKey ? preview.error : null;
  const mode = previewMode(filename);
  const label = `${filename} ${kind} preview`;

  useEffect(() => {
    const controller = new AbortController();
    let blobUrl: string | null = null;
    void fetch(buildFileUrl(filePath, { sessionId }), {
      headers: buildApiHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview failed (${response.status})`);
        blobUrl = URL.createObjectURL(await response.blob());
        if (!controller.signal.aborted) {
          setPreview({ key: previewKey, url: blobUrl, error: null });
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setPreview({
          key: previewKey,
          url: null,
          error: reason instanceof Error ? reason.message : "Preview failed",
        });
      });
    return () => {
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [filePath, previewKey, sessionId]);

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
          {error ? (
            <p className="text-sm text-red-500" role="alert">{error}</p>
          ) : !url ? (
            <p className="text-sm text-muted" role="status">Loading preview...</p>
          ) : mode === "image" ? (
            <img src={url} alt={label} className="max-h-full max-w-full rounded-[8px] object-contain" />
          ) : mode === "audio" ? (
            <audio src={url} controls className="w-full max-w-xl" />
          ) : mode === "video" ? (
            <video src={url} controls className="max-h-full max-w-full rounded-[8px]" />
          ) : mode === "pdf" || mode === "text" ? (
            <iframe title={label} src={url} className="h-full w-full rounded-[8px] border bg-white" />
          ) : (
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
