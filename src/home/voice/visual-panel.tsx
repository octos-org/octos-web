import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { buildFileUrl } from "@/api/files";
import { buildApiHeaders } from "@/api/client";
import type { VisualArtifact } from "./use-voice-conversation";

interface VisualPanelProps {
  visual: VisualArtifact;
  sessionId: string;
  onClose: () => void;
}

/**
 * Renders a voice-turn rich-output artifact. Fills its container, which the
 * voice view docks on the right so the next turn can be spoken while looking
 * at it.
 *
 * - HTML → a **sandboxed iframe** (`sandbox="allow-scripts"`, no
 *   `allow-same-origin`) via `srcDoc`, so interactive demos run their own JS
 *   without any access to the host origin / storage / cookies.
 * - Image → an `<img>` from an object URL.
 *
 * Both are fetched through `/api/files` (session-scoped, auth headers), mirroring
 * how reply audio is fetched, since the file lives under the turn workspace.
 */
export function VisualPanel({ visual, sessionId, onClose }: VisualPanelProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    // The parent keys this component by `visual.path`, so a new artifact mounts
    // a fresh instance — no need to reset state synchronously here (which would
    // trigger cascading renders). We only set state from the async callbacks.
    let cancelled = false;
    let objectUrl: string | null = null;
    const url = `${buildFileUrl(visual.path)}?session=${encodeURIComponent(sessionId)}`;
    void (async () => {
      try {
        const resp = await fetch(url, { headers: buildApiHeaders() });
        if (!resp.ok) throw new Error(`visual fetch ${resp.status}`);
        if (visual.kind === "html") {
          const text = await resp.text();
          if (!cancelled) setHtml(text);
        } else {
          const blob = await resp.blob();
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) setImgUrl(objectUrl);
        }
      } catch (e) {
        console.error("[voice] visual fetch failed", e);
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visual.path, visual.kind, sessionId]);

  return (
    <div className="relative flex h-full w-full flex-col bg-black/40 p-4">
      <button
        onClick={onClose}
        aria-label="close visual"
        className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/70"
      >
        <X size={22} />
      </button>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-2xl bg-white/5">
        {error && <div className="text-sm text-white/60">视觉内容加载失败</div>}
        {!error && visual.kind === "html" && html !== null && (
          <iframe
            title="rich-output"
            srcDoc={html}
            sandbox="allow-scripts"
            className="h-full w-full rounded-2xl border-0 bg-white"
          />
        )}
        {!error && visual.kind === "image" && imgUrl && (
          <img
            src={imgUrl}
            alt="rich-output"
            className="max-h-full max-w-full rounded-2xl object-contain"
          />
        )}
        {!error &&
          ((visual.kind === "html" && html === null) ||
            (visual.kind === "image" && !imgUrl)) && (
            <div className="text-sm text-white/55">加载中…</div>
          )}
      </div>
    </div>
  );
}
