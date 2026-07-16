import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";

export async function downloadStudioFile(
  filePath: string,
  filename: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(buildFileUrl(filePath, {
    sessionId,
    workspaceScoped: true,
  }), {
    headers: buildApiHeaders(),
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const blobUrl = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  }
}
