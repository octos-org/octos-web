import { useEffect, useState, type ReactNode } from "react";

import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";

import type { AssetFile } from "./generated-assets";
import { readResponseTextWithLimit } from "./limited-response";

const MAX_STRUCTURED_ASSET_BYTES = 2 * 1024 * 1024;

export function AuthenticatedTextFile({
  file,
  sessionId,
  children,
  empty,
}: {
  file?: AssetFile;
  sessionId: string;
  children: (text: string) => ReactNode;
  empty: ReactNode;
}) {
  const [state, setState] = useState<{
    key: string;
    text: string | null;
    error: string | null;
  }>({ key: file?.filePath ?? "", text: null, error: null });
  const filePath = file?.filePath ?? "";
  const key = filePath;
  const declaredSizeError = file?.size !== undefined
    && file.size > MAX_STRUCTURED_ASSET_BYTES
    ? "This asset is too large for the interactive viewer."
    : null;
  const current = declaredSizeError
    ? { key, text: null, error: declaredSizeError }
    : state.key === key
      ? state
      : { key, text: null, error: null };

  useEffect(() => {
    if (!filePath) return;
    if (declaredSizeError) return;
    const controller = new AbortController();
    void fetch(buildFileUrl(filePath, { sessionId, workspaceScoped: true }), {
      headers: buildApiHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview failed (${response.status})`);
        const text = await readResponseTextWithLimit(
          response,
          MAX_STRUCTURED_ASSET_BYTES,
          "This asset is too large for the interactive viewer.",
        );
        if (!controller.signal.aborted) setState({ key, text, error: null });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setState({ key, text: null, error: reason instanceof Error ? reason.message : "Preview failed" });
        }
      });
    return () => controller.abort();
  }, [declaredSizeError, filePath, key, sessionId]);

  if (!file) return <div className="studio-empty-state m-4 text-xs">{empty}</div>;
  if (current.error) return <div className="studio-empty-state m-4 text-xs text-red-500" role="alert">{current.error}</div>;
  if (current.text === null) return <div className="studio-empty-state m-4 text-xs" role="status">Loading interactive preview…</div>;
  return <>{children(current.text)}</>;
}
