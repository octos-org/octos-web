import { useEffect, useState } from "react";

import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import { MarkdownContent } from "@/components/markdown-renderer";

type PreviewMode = "image" | "audio" | "video" | "pdf" | "text" | "unsupported";

const ACTIVE_CONTENT_TYPES = new Set([
  "application/xhtml+xml",
  "image/svg+xml",
  "text/html",
]);

function normalizedMediaType(mediaType?: string): string {
  return mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isActiveContentType(mediaType?: string): boolean {
  return ACTIVE_CONTENT_TYPES.has(normalizedMediaType(mediaType));
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function previewMode(filename: string, mediaType?: string): PreviewMode {
  if (isActiveContentType(mediaType)) return "unsupported";
  switch (normalizedMediaType(mediaType)) {
    case "application/pdf":
      return "pdf";
    case "text/markdown":
    case "text/plain":
    case "text/csv":
    case "application/json":
      return "text";
    case "audio/mpeg":
    case "audio/wav":
    case "audio/mp4":
      return "audio";
    case "video/mp4":
    case "video/webm":
      return "video";
  }
  if (normalizedMediaType(mediaType).startsWith("image/")) return "image";
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
  mediaType?: string;
  sessionId: string;
  kind: "source" | "asset";
}

function isMarkdown(filename: string, mediaType?: string): boolean {
  const extension = extensionOf(filename);
  return normalizedMediaType(mediaType) === "text/markdown"
    || extension === "md"
    || extension === "markdown";
}

function safeBlobMediaType(
  mode: PreviewMode,
  filename: string,
  declaredType?: string,
  responseType?: string,
): string {
  const declared = normalizedMediaType(declaredType);
  const response = normalizedMediaType(responseType);
  if (mode === "pdf") return "application/pdf";
  if (mode === "image") {
    if (declared.startsWith("image/") && !isActiveContentType(declared)) return declared;
    if (response.startsWith("image/") && !isActiveContentType(response)) return response;
    const extension = extensionOf(filename);
    return extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : `image/${extension || "png"}`;
  }
  if (mode === "audio") {
    if (declared.startsWith("audio/")) return declared;
    if (response.startsWith("audio/")) return response;
    return extensionOf(filename) === "mp3" ? "audio/mpeg" : `audio/${extensionOf(filename)}`;
  }
  if (mode === "video") {
    if (declared.startsWith("video/")) return declared;
    if (response.startsWith("video/")) return response;
    return `video/${extensionOf(filename)}`;
  }
  return "application/octet-stream";
}

export function StudioFilePreview({
  filename,
  filePath,
  mediaType,
  sessionId,
  kind,
}: Props) {
  const previewKey = `${sessionId}\0${filePath}`;
  const [preview, setPreview] = useState<{
    key: string;
    url: string | null;
    text: string | null;
    error: string | null;
  }>({ key: previewKey, url: null, text: null, error: null });
  const url = preview.key === previewKey ? preview.url : null;
  const text = preview.key === previewKey ? preview.text : null;
  const error = preview.key === previewKey ? preview.error : null;
  const mode = previewMode(filename, mediaType);
  const label = `${filename} ${kind} preview`;

  useEffect(() => {
    if (mode === "unsupported") return;
    const controller = new AbortController();
    let blobUrl: string | null = null;
    void fetch(buildFileUrl(filePath, { sessionId }), {
      headers: buildApiHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview failed (${response.status})`);
        if (mode === "text") {
          const content = await response.text();
          if (!controller.signal.aborted) {
            setPreview({ key: previewKey, url: null, text: content, error: null });
          }
          return;
        }
        const blob = await response.blob();
        if (isActiveContentType(blob.type)) {
          throw new Error("Preview blocked because the file contains active content.");
        }
        blobUrl = URL.createObjectURL(new Blob([blob], {
          type: safeBlobMediaType(mode, filename, mediaType, blob.type),
        }));
        if (!controller.signal.aborted) {
          setPreview({ key: previewKey, url: blobUrl, text: null, error: null });
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setPreview({
          key: previewKey,
          url: null,
          text: null,
          error: reason instanceof Error ? reason.message : "Preview failed",
        });
      });
    return () => {
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [filePath, filename, mediaType, mode, previewKey, sessionId]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface/40 p-3">
          {error ? (
            <p className="text-sm text-red-500" role="alert">{error}</p>
          ) : mode === "text" && text !== null ? (
            isMarkdown(filename, mediaType) ? (
              <MarkdownContent
                text={text}
                className="min-h-full w-full overflow-wrap-anywhere text-sm"
              />
            ) : (
              <pre className="min-h-full w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                {text}
              </pre>
            )
          ) : mode === "unsupported" ? (
            <p className="text-center text-sm text-muted">
              Preview unavailable for this file type.
            </p>
          ) : !url ? (
            <p className="text-sm text-muted" role="status">Loading preview...</p>
          ) : mode === "image" ? (
            <img src={url} alt={label} className="max-h-full max-w-full rounded-[8px] object-contain" />
          ) : mode === "audio" ? (
            <audio src={url} controls className="w-full max-w-xl" />
          ) : mode === "video" ? (
            <video src={url} controls className="max-h-full max-w-full rounded-[8px]" />
          ) : mode === "pdf" ? (
            <iframe
              title={label}
              src={url}
              sandbox=""
              className="h-full w-full rounded-[8px] border bg-white"
            />
          ) : null
          }
      </div>
    </div>
  );
}
