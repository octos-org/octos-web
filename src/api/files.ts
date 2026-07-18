import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";

export interface BuildFileUrlOptions {
  sessionId?: string;
}

function shouldUseSessionScopedFileUrl(filePath: string, sessionId?: string): boolean {
  return Boolean(
    sessionId &&
      (filePath.startsWith("uploads/") || filePath.startsWith("ws/")),
  );
}

function shouldUseQueryFileUrl(filePath: string, sessionId?: string): boolean {
  const isAbsolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(filePath);
  return shouldUseSessionScopedFileUrl(filePath, sessionId) || isAbsolute;
}

export function buildFileUrl(
  filePath: string,
  options: BuildFileUrlOptions = {},
): string {
  if (shouldUseQueryFileUrl(filePath, options.sessionId)) {
    const params = new URLSearchParams();
    params.set("path", filePath);
    if (options.sessionId) {
      params.set("session", options.sessionId);
    }
    return `${API_BASE}/api/files?${params.toString()}`;
  }
  return `${API_BASE}/api/files/${encodeURIComponent(filePath)}`;
}

export function buildAuthenticatedFileUrl(
  filePath: string,
  options: BuildFileUrlOptions = {},
): string {
  const token = getToken();
  const base = buildFileUrl(filePath, options);
  const separator = base.includes("?") ? "&" : "?";
  return token ? `${base}${separator}token=${encodeURIComponent(token)}` : base;
}
