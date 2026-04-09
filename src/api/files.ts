import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";

export function buildFileUrl(filePath: string): string {
  return `${API_BASE}/api/files/${encodeURIComponent(filePath)}`;
}

export function buildAuthenticatedFileUrl(filePath: string): string {
  const token = getToken();
  const base = buildFileUrl(filePath);
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
