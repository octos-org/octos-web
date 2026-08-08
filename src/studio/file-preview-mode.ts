export type PreviewMode = "image" | "audio" | "video" | "pdf" | "text" | "unsupported";

const ACTIVE_CONTENT_TYPES = new Set([
  "application/xhtml+xml",
  "image/svg+xml",
  "text/html",
]);

export function normalizedMediaType(mediaType?: string): string {
  return mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isActiveContentType(mediaType?: string): boolean {
  return ACTIVE_CONTENT_TYPES.has(normalizedMediaType(mediaType));
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

export function previewMode(filename: string, mediaType?: string): PreviewMode {
  if (isActiveContentType(mediaType)) return "unsupported";
  switch (normalizedMediaType(mediaType)) {
    case "application/pdf": return "pdf";
    case "text/markdown":
    case "text/plain":
    case "text/csv":
    case "application/json": return "text";
  }
  const normalizedType = normalizedMediaType(mediaType);
  if (normalizedType.startsWith("image/")) return "image";
  if (normalizedType.startsWith("audio/")) return "audio";
  if (normalizedType.startsWith("video/")) return "video";
  const ext = extensionOf(filename);
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown", "txt", "csv", "json"].includes(ext)) return "text";
  return "unsupported";
}

export function isFilePreviewable(filename: string, mediaType?: string): boolean {
  return previewMode(filename, mediaType) !== "unsupported";
}
