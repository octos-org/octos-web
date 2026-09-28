import { buildApiHeaders, getIdentityGeneration, getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";

export interface BuildFileUrlOptions {
  sessionId?: string;
  /** Resolve a relative path inside the current session workspace. */
  workspaceScoped?: boolean;
}

function shouldUseSessionScopedFileUrl(filePath: string, sessionId?: string): boolean {
  return Boolean(
    sessionId &&
      (filePath.startsWith("uploads/") || filePath.startsWith("ws/")),
  );
}

function shouldUseQueryFileUrl(
  filePath: string,
  options: BuildFileUrlOptions,
): boolean {
  const isAbsolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(filePath);
  return Boolean(options.workspaceScoped && options.sessionId)
    || shouldUseSessionScopedFileUrl(filePath, options.sessionId)
    || isAbsolute;
}

export function buildFileUrl(
  filePath: string,
  options: BuildFileUrlOptions = {},
): string {
  if (shouldUseQueryFileUrl(filePath, options)) {
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

/** Download through fetch so browser navigation never needs a bearer URL. */
export async function downloadFile(url: string, fallbackFilename = "download"): Promise<void> {
  const target = new URL(url, window.location.href);
  const isFileApi = target.origin === window.location.origin
    && /^\/api\/files(?:\/|$)/.test(target.pathname);
  const token = getToken();
  const identity = getIdentityGeneration();
  const response = await fetch(target.href, {
    headers: isFileApi ? buildApiHeaders() : {},
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}). Please retry.`);
  const blob = await response.blob();
  if (getToken() !== token || identity !== getIdentityGeneration()) throw new Error("Account changed. Please download again.");
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fallbackFilename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser time to consume the URL before releasing the blob.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
