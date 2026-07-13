import { useEffect, useState } from "react";

import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import { MarkdownContent } from "@/components/markdown-renderer";

import { CsvTableViewer, JsonViewer } from "./structured-file-viewers";
import {
  extensionOf,
  isActiveContentType,
  normalizedMediaType,
  previewMode,
  type PreviewMode,
} from "./file-preview-mode";

const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_BINARY_BYTES = 50 * 1024 * 1024;


interface Props {
  filename: string;
  filePath: string;
  mediaType?: string;
  size?: number;
  sessionId: string;
  kind: "source" | "asset";
  lineRange?: { start: number; end: number };
  fallbackAction?: { label: string; onClick: () => void };
}

function isMarkdown(filename: string, mediaType?: string): boolean {
  const extension = extensionOf(filename);
  return normalizedMediaType(mediaType) === "text/markdown"
    || extension === "md"
    || extension === "markdown";
}

function isJson(filename: string, mediaType?: string): boolean {
  return normalizedMediaType(mediaType) === "application/json" || extensionOf(filename) === "json";
}

function isCsv(filename: string, mediaType?: string): boolean {
  return normalizedMediaType(mediaType) === "text/csv" || extensionOf(filename) === "csv";
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
  size,
  sessionId,
  kind,
  lineRange,
  fallbackAction,
}: Props) {
  const previewKey = `${sessionId}\0${filePath}`;
  const mode = previewMode(filename, mediaType);
  const declaredSizeError = mode !== "text"
    && size !== undefined
    && size > MAX_INLINE_BINARY_BYTES
    ? "This file is too large to preview. Download it to view the full content."
    : null;
  const [preview, setPreview] = useState<{
    key: string;
    url: string | null;
    text: string | null;
    error: string | null;
  }>({ key: previewKey, url: null, text: null, error: null });
  const url = preview.key === previewKey ? preview.url : null;
  const text = preview.key === previewKey ? preview.text : null;
  const error = declaredSizeError ?? (preview.key === previewKey ? preview.error : null);
  const label = `${filename} ${kind} preview`;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (mode === "unsupported") return;
    if (declaredSizeError) return;
    const controller = new AbortController();
    let blobUrl: string | null = null;
    void fetch(buildFileUrl(filePath, { sessionId, workspaceScoped: true }), {
      headers: buildApiHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview failed (${response.status})`);
        if (mode === "text") {
          const contentLength = Number(response.headers?.get("content-length"));
          if (Number.isFinite(contentLength) && contentLength > MAX_INLINE_TEXT_BYTES) {
            throw new Error("This file is too large to preview. Download it to view the full content.");
          }
          const content = await response.text();
          if (new TextEncoder().encode(content).byteLength > MAX_INLINE_TEXT_BYTES) {
            throw new Error("This file is too large to preview. Download it to view the full content.");
          }
          if (!controller.signal.aborted) {
            setPreview({ key: previewKey, url: null, text: content, error: null });
          }
          return;
        }
        const contentLength = Number(response.headers?.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_INLINE_BINARY_BYTES) {
          throw new Error("This file is too large to preview. Download it to view the full content.");
        }
        const blob = await response.blob();
        if (blob.size > MAX_INLINE_BINARY_BYTES) {
          throw new Error("This file is too large to preview. Download it to view the full content.");
        }
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
  }, [attempt, declaredSizeError, filePath, filename, mediaType, mode, previewKey, sessionId]);

  const citedLineContext = text !== null && lineRange
    ? (() => {
        const lines = text.split("\n");
        const first = Math.max(1, lineRange.start - 3);
        const last = Math.min(lines.length, lineRange.end + 3);
        return {
          first,
          last,
          lines: lines.slice(first - 1, last),
        };
      })()
    : null;
  const textPreviewReady = mode === "text" && text !== null && !error;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div
        key={previewKey}
        data-testid="studio-file-preview-viewport"
        className={`min-h-0 flex-1 overflow-auto bg-surface/40 p-3 ${textPreviewReady ? "block" : "flex items-center justify-center"}`}
      >
          {error ? (
            <div className="text-center">
              <p className="text-sm text-red-500" role="alert">{error}</p>
              <div className="mt-3 flex justify-center gap-2">
                <button type="button" className="studio-ghost-button px-3 py-2 text-xs" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
                {fallbackAction && <button type="button" className="studio-button-primary px-3 py-2 text-xs" onClick={fallbackAction.onClick}>{fallbackAction.label}</button>}
              </div>
            </div>
          ) : mode === "text" && text !== null ? (
            isMarkdown(filename, mediaType) && lineRange ? (
              <div className="h-full w-full overflow-auto rounded-lg border bg-surface font-mono text-xs">
                {citedLineContext && (
                  <p className="sticky top-0 z-10 border-b bg-surface px-3 py-2 text-[11px] text-muted">
                    Showing lines {citedLineContext.first}–{citedLineContext.last}
                  </p>
                )}
                {citedLineContext?.lines.map((line, index) => {
                  const lineNumber = citedLineContext.first + index;
                  const cited = lineNumber >= lineRange.start && lineNumber <= lineRange.end;
                  return (
                    <div key={lineNumber} data-cited-line={cited || undefined} className={`grid grid-cols-[3rem_1fr] border-b ${cited ? "bg-accent/10" : ""}`}>
                      <span className="select-none border-r px-2 py-1 text-right text-muted">{lineNumber}</span>
                      <span className="whitespace-pre-wrap break-words px-2 py-1">{line || " "}</span>
                    </div>
                  );
                })}
              </div>
            ) : isMarkdown(filename, mediaType) ? (
              <MarkdownContent
                text={text}
                className="min-h-full w-full overflow-wrap-anywhere text-sm"
              />
            ) : isJson(filename, mediaType) ? (
              <JsonViewer text={text} />
            ) : isCsv(filename, mediaType) ? (
              <CsvTableViewer text={text} filename={filename} />
            ) : (
              <pre className="min-h-full w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                {text}
              </pre>
            )
          ) : mode === "unsupported" ? (
            <div className="text-center">
              <p className="text-sm text-muted">Preview unavailable for this file type.</p>
              {fallbackAction && <button type="button" className="studio-button-primary mt-3 px-3 py-2 text-xs" onClick={fallbackAction.onClick}>{fallbackAction.label}</button>}
            </div>
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
              className="h-full w-full rounded-[8px] border bg-white"
            />
          ) : null
          }
      </div>
    </div>
  );
}
