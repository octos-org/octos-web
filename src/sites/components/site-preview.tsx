import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface Props {
  previewUrl?: string;
  siteName: string;
  template: string;
  sessionId?: string;
  scaffoldError?: string;
}

export function SitePreview({
  previewUrl,
  siteName,
  template,
  sessionId,
  scaffoldError,
}: Props) {
  const [refreshTick, setRefreshTick] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const autoRefreshAttempts = useRef(0);
  const autoRefreshTimer = useRef<number | null>(null);
  const eventRefreshTimer = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);

  const triggerRefresh = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  const scheduleRetry = useCallback(() => {
    if (autoRefreshAttempts.current >= 8 || autoRefreshTimer.current !== null) return;
    autoRefreshAttempts.current += 1;
    autoRefreshTimer.current = window.setTimeout(() => {
      autoRefreshTimer.current = null;
      triggerRefresh();
    }, 2500);
  }, [triggerRefresh]);

  useEffect(() => {
    autoRefreshAttempts.current = 0;
    setStatus(null);
    if (autoRefreshTimer.current !== null) {
      window.clearTimeout(autoRefreshTimer.current);
      autoRefreshTimer.current = null;
    }
  }, [previewUrl]);

  useEffect(() => {
    return () => {
      if (autoRefreshTimer.current !== null) {
        window.clearTimeout(autoRefreshTimer.current);
      }
      if (eventRefreshTimer.current !== null) {
        window.clearTimeout(eventRefreshTimer.current);
      }
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId || !previewUrl) return;

    function matchesSession(detail: unknown): boolean {
      return (
        !!detail &&
        typeof detail === "object" &&
        "sessionId" in detail &&
        detail.sessionId === sessionId
      );
    }

    function scheduleEventRefresh() {
      if (eventRefreshTimer.current !== null) {
        window.clearTimeout(eventRefreshTimer.current);
      }
      setStatus("Refreshing preview...");
      eventRefreshTimer.current = window.setTimeout(() => {
        eventRefreshTimer.current = null;
        triggerRefresh();
      }, 900);
    }

    function handleEvent(event: Event) {
      const detail =
        event instanceof CustomEvent ? (event.detail as unknown) : undefined;
      if (!matchesSession(detail)) return;
      scheduleEventRefresh();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        scheduleEventRefresh();
      }
    }

    window.addEventListener("focus", scheduleEventRefresh);
    window.addEventListener("crew:file", handleEvent);
    window.addEventListener("crew:bg_tasks", handleEvent);
    window.addEventListener("crew:task_status", handleEvent);
    window.addEventListener("crew:tool_progress", handleEvent);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (eventRefreshTimer.current !== null) {
        window.clearTimeout(eventRefreshTimer.current);
        eventRefreshTimer.current = null;
      }
      window.removeEventListener("focus", scheduleEventRefresh);
      window.removeEventListener("crew:file", handleEvent);
      window.removeEventListener("crew:bg_tasks", handleEvent);
      window.removeEventListener("crew:task_status", handleEvent);
      window.removeEventListener("crew:tool_progress", handleEvent);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [previewUrl, sessionId, triggerRefresh]);

  const iframeUrl = useMemo(() => {
    if (!previewUrl) return "";
    const separator = previewUrl.includes("?") ? "&" : "?";
    return `${previewUrl}${separator}v=${refreshTick}`;
  }, [previewUrl, refreshTick]);

  const handleCopyPreviewUrl = useCallback(() => {
    if (!previewUrl) return;
    void navigator.clipboard.writeText(previewUrl).then(() => {
      setCopied(true);
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = window.setTimeout(() => {
        copiedTimer.current = null;
        setCopied(false);
      }, 1800);
    });
  }, [previewUrl]);

  const handleLoad = useCallback(
    (event: SyntheticEvent<HTMLIFrameElement>) => {
      const frame = event.currentTarget;
      const title = frame.contentDocument?.title?.trim() || "";
      const fallbackTitles = new Set([
        "Site Preview Not Found",
        "Missing Site Metadata",
        "Preview Build Failed",
        "Preview Asset Missing",
      ]);

      if (fallbackTitles.has(title)) {
        setStatus(`${title}. Retrying preview...`);
        scheduleRetry();
        return;
      }

      setStatus(null);
      autoRefreshAttempts.current = 0;
    },
    [scheduleRetry],
  );

  if (!previewUrl) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
        {scaffoldError || "The preview URL will appear once the backend scaffold finishes."}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text">{siteName}</div>
          <div className="truncate text-xs text-muted">{template}</div>
          <div className="truncate text-[11px] text-muted/70">{previewUrl}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyPreviewUrl}
            className="rounded-lg p-2 text-muted transition hover:bg-surface-container hover:text-text"
            title="Copy preview URL"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button
            onClick={triggerRefresh}
            className="rounded-lg p-2 text-muted transition hover:bg-surface-container hover:text-text"
            title="Refresh preview"
          >
            <RefreshCw size={16} />
          </button>
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg p-2 text-muted transition hover:bg-surface-container hover:text-text"
            title="Open preview in new tab"
          >
            <ExternalLink size={16} />
          </a>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-surface-dark p-3">
        <div className="h-full overflow-hidden rounded-2xl border border-border bg-white shadow-2xl">
          <iframe
            key={iframeUrl}
            src={iframeUrl}
            title={`${siteName} preview`}
            className="h-full w-full border-0"
            onLoad={handleLoad}
          />
        </div>
        {status && (
          <div className="px-1 pt-2 text-xs text-muted">{status}</div>
        )}
      </div>
    </div>
  );
}
