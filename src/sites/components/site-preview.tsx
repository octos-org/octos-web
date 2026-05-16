import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type SignedPreviewResponse, signPreview } from "../api";

interface Props {
  /** Legacy plain preview URL — used for the "open in new tab" button
   * and the copyable URL row. The iframe `src` is computed from the
   * signed-URL flow below. */
  previewUrl?: string;
  siteName: string;
  template: string;
  sessionId?: string;
  scaffoldError?: string;
  /** Profile id the active site lives under. Required for signing. */
  profileId?: string | null;
  /** Site slug. Required for signing. */
  slug?: string;
}

/**
 * `<SitePreview>` post-PR #1001.
 *
 * PR #1001 closed the cross-tenant `/api/preview/{profile_id}/...`
 * data-read by requiring `Authorization: Bearer ...` on every request.
 * That regressed the iframe UX (iframes cannot inject headers), so
 * codex's design (PR #1006-ish): mint a signed-URL token via
 * `POST /api/my/preview/sign` and point `iframe.src` at the returned
 * `preview_url` — the token IS the credential for the iframe GETs.
 *
 * Renewal cadence: re-sign at `expires_at - 60s` so the in-flight
 * iframe never hits a 404 on a freshly-expired token. The component
 * tracks the latest signed URL in state and updates `iframe.src` when
 * the renewal returns.
 *
 * If the sign call rejects (e.g. 403 because the user logged out, or
 * the profile no longer matches), the component renders an error UI
 * with a retry button rather than silently pointing the iframe at the
 * stale URL.
 */
export function SitePreview({
  previewUrl,
  siteName,
  template,
  sessionId,
  scaffoldError,
  profileId,
  slug,
}: Props) {
  const [refreshTick, setRefreshTick] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [signed, setSigned] = useState<SignedPreviewResponse | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const autoRefreshAttempts = useRef(0);
  const autoRefreshTimer = useRef<number | null>(null);
  const eventRefreshTimer = useRef<number | null>(null);
  const renewalTimer = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);
  /**
   * Latest-wins guard for in-flight `signPreview()` promises.
   *
   * `signPreview()` is async. Between the call site and its resolution,
   * the component may have unmounted (cleanup ran) OR the preview
   * coordinates may have changed (a newer sign is already in flight).
   * In either case the resolution must NOT call `setState` or schedule
   * a renewal — doing so leaks the old preview into the new render and,
   * post-unmount, leaks the renewal timer forever.
   *
   * Implementation: each call site increments `signReqId.current` and
   * captures its own id. When the promise resolves, it checks the
   * latest id; if they differ the result is dropped on the floor.
   * The unmount cleanup ALSO bumps `signReqId.current` so any
   * in-flight resolutions see the bumped id and short-circuit.
   *
   * This single-ref design replaces an earlier `mounted` boolean ref
   * (codex round-3 HIGH): a `mounted` ref set to `false` in cleanup
   * would never reset on remount under React 19 StrictMode dev mode,
   * so every signPreview resolution after the first effect cleanup
   * was silently dropped → the iframe was stuck on "Loading preview…"
   * in dev. The request-id check alone is sufficient: bumping
   * `signReqId.current` on cleanup makes every in-flight resolution
   * stale relative to any subsequent mount.
   */
  const signReqId = useRef(0);

  const triggerRefresh = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  const scheduleRetry = useCallback(() => {
    if (autoRefreshAttempts.current >= 8 || autoRefreshTimer.current !== null)
      return;
    autoRefreshAttempts.current += 1;
    autoRefreshTimer.current = window.setTimeout(() => {
      autoRefreshTimer.current = null;
      triggerRefresh();
    }, 2500);
  }, [triggerRefresh]);

  /**
   * Sign and (re-)mint a signed-URL token. Stashes the result in
   * state so the iframe re-renders against `signed.preview_url`, and
   * schedules a renewal at `expires_at - 60s`. We clamp the renewal
   * window to a minimum of 250 ms so a clock skew or a very short TTL
   * (test rigs use 5-second TTLs) doesn't pin the iframe on a stale
   * URL while React batches the state update.
   */
  const refreshSignedToken = useCallback(async () => {
    if (!profileId || !sessionId || !slug) {
      // Missing coordinates — we cannot mint a signed token, but the
      // caller's `previewUrl` row may still surface scaffold status,
      // so don't surface an "error" here. The iframe will simply not
      // render until the coordinates arrive (typically on first poll).
      // Bump the request id so any in-flight sign for the previous
      // (valid) coordinates is dropped on resolution.
      signReqId.current += 1;
      setSigned(null);
      setSignError(null);
      return;
    }
    // Latest-wins guard (codex GAP 2/3): capture this call's request
    // id BEFORE awaiting, so resolutions for stale coordinates / a
    // previously-unmounted instance can be discarded by comparing
    // against the live `signReqId.current` after the await.
    const myReqId = ++signReqId.current;
    try {
      const response = await signPreview({
        profile_id: profileId,
        session_id: sessionId,
        site_slug: slug,
      });
      // Drop the response if the coordinates changed mid-flight or
      // the component unmounted. Without this, a slow `signPreview`
      // followed by a rapid prop change or unmount leaks state +
      // schedules a renewal timer that fires on a dead component.
      // Unmount cleanup bumps `signReqId.current`, so a stale
      // resolution sees a different id and bails.
      if (signReqId.current !== myReqId) {
        return;
      }
      setSigned(response);
      setSignError(null);

      // Schedule renewal at expires_at - 60s, clamped to a positive
      // window so test rigs (5-second TTLs) don't no-op the timer.
      // The renewal is keyed to `myReqId` via the latest-wins guard
      // INSIDE its `refreshSignedToken` recursion — a newer sign
      // bumps `signReqId.current`, so when this timer's recursive
      // call awaits and re-enters the guard, it'll see the bumped id
      // and drop the result. The timer itself is cleared on cleanup.
      if (renewalTimer.current !== null) {
        window.clearTimeout(renewalTimer.current);
      }
      const expiresMs = Date.parse(response.expires_at);
      const nowMs = Date.now();
      const delay = Math.max(250, expiresMs - nowMs - 60_000);
      renewalTimer.current = window.setTimeout(() => {
        renewalTimer.current = null;
        if (signReqId.current !== myReqId) return;
        void refreshSignedToken();
      }, delay);
    } catch (error) {
      // Same guard on the error path: don't surface an old failure
      // after the user has navigated to a different preview.
      if (signReqId.current !== myReqId) {
        return;
      }
      const message = error instanceof Error ? error.message : "sign failed";
      setSignError(message);
      setSigned(null);
    }
  }, [profileId, sessionId, slug]);

  // Mint on mount and whenever the coordinates change. The renewal
  // is scheduled INSIDE refreshSignedToken (after each successful
  // sign) so changing coordinates cancels any in-flight renewal.
  useEffect(() => {
    void refreshSignedToken();
    return () => {
      if (renewalTimer.current !== null) {
        window.clearTimeout(renewalTimer.current);
        renewalTimer.current = null;
      }
    };
  }, [refreshSignedToken]);

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
      // Bump the request id so any in-flight `signPreview()`
      // resolution returns without touching state or scheduling
      // timers (codex GAP 2/3 latest-wins guard). The earlier
      // implementation used a `mounted` boolean ref but never
      // reset it on remount, which under React 19 StrictMode dev
      // mode silently dropped every subsequent sign — see the
      // `should_recover_after_unmount_remount_cycle` test.
      signReqId.current += 1;
      if (autoRefreshTimer.current !== null) {
        window.clearTimeout(autoRefreshTimer.current);
      }
      if (eventRefreshTimer.current !== null) {
        window.clearTimeout(eventRefreshTimer.current);
      }
      if (renewalTimer.current !== null) {
        window.clearTimeout(renewalTimer.current);
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
    if (!signed?.preview_url) return "";
    const separator = signed.preview_url.includes("?") ? "&" : "?";
    return `${signed.preview_url}${separator}v=${refreshTick}`;
  }, [signed?.preview_url, refreshTick]);

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
        {scaffoldError ||
          "The preview URL will appear once the backend scaffold finishes."}
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
          {signError ? (
            <div
              data-testid="site-preview-error"
              className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted"
            >
              <div>
                Preview is unavailable: <code>{signError}</code>
              </div>
              <button
                onClick={() => void refreshSignedToken()}
                className="rounded-lg border border-border px-3 py-1 text-xs text-text hover:bg-surface-container"
              >
                Retry
              </button>
            </div>
          ) : iframeUrl ? (
            /*
             * Issue #993 / PR #139 — iframe sandbox (XSS bridge fix).
             *
             * The preview is same-origin with the SPA
             * (`API_BASE === ""`). Without a `sandbox` attribute, the
             * LLM-authored HTML/JS in the preview can read
             * `window.parent.localStorage` and exfiltrate
             * `octos_session_token` + `octos_auth_token`.
             *
             * `allow-scripts` + `allow-forms` are required for
             * legitimate framework hydration (Next/Astro/React) and
             * site forms. `allow-same-origin` is INTENTIONALLY OMITTED
             * — granting it would defeat the fix because the iframe
             * IS same-origin with the parent, so it could still reach
             * `window.parent.localStorage`.
             *
             * This duplicates the attribute from PR #139
             * (`fix/site-preview-iframe-sandbox`). If #139 merges
             * first, this PR's rebase resolves to the same value; if
             * this PR merges first, #139 has a clean rebase.
             */
            <iframe
              key={iframeUrl}
              src={iframeUrl}
              title={`${siteName} preview`}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-forms"
              onLoad={handleLoad}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted">
              Loading preview…
            </div>
          )}
        </div>
        {status && (
          <div className="px-1 pt-2 text-xs text-muted">{status}</div>
        )}
      </div>
    </div>
  );
}
