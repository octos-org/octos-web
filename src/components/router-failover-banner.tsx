/**
 * Wave4-A `crew:router_failover` transient banner.
 *
 * Listens for the DOM event the event-router dispatches when the
 * adaptive router crosses lanes and surfaces a 4 s auto-dismiss
 * notice. The chat-layout mounts a single instance under the main
 * scroll area; the banner stacks if multiple failovers fire in
 * sequence (subsequent ones replace the visible one and reset the
 * timer).
 *
 * Scope: filters by the active session id passed via `sessionId`
 * prop (or `useSession()`'s `currentSessionId` when absent). Late
 * events from a previously-active bridge are dropped so a banner
 * for a non-visible session doesn't pop up during a rapid session
 * switch (codex Wave4-A P2 review fix).
 *
 * Shape mirrors the existing inline file toast in `chat-layout.tsx`
 * — no shared toast infrastructure exists, so this component owns
 * its own state.
 */

import { useEffect, useState } from "react";
import { useSession } from "@/runtime/session-context";
import { eventMatchesScope } from "@/runtime/event-scope";

interface FailoverDetail {
  sessionId: string;
  topic?: string;
  from: string;
  to: string;
  reason: string;
  elapsedMs: number;
}

interface VisibleFailover extends FailoverDetail {
  /** Monotonic id so React keys the latest banner uniquely. Without
   *  this, two failovers with the same `from`/`to` pair would render
   *  with the same key and React would not remount the timer. */
  key: number;
}

export interface RouterFailoverBannerProps {
  /** Test-injection: override the auto-dismiss interval. */
  dismissAfterMs?: number;
  /** Test-injection: bypass `useSession()` for component-level tests. */
  sessionId?: string;
}

export function RouterFailoverBanner({
  dismissAfterMs = 4000,
  sessionId,
}: RouterFailoverBannerProps = {}) {
  const session = useSession();
  const activeSessionId = sessionId ?? session.currentSessionId;
  const activeTopic = session.historyTopic;
  const [visible, setVisible] = useState<VisibleFailover | null>(null);

  // Codex Wave4-A P2 review fix: drop any in-flight banner on session
  // / topic change so a non-current view's failover doesn't keep showing.
  useEffect(() => {
    setVisible(null);
  }, [activeSessionId, activeTopic]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let keySeq = 0;
    function handle(e: Event) {
      const detail = (e as CustomEvent).detail as FailoverDetail | undefined;
      if (!detail) return;
      // Codex Wave4-A P2 (round 2): scope by sessionId AND topic via
      // the shared `eventMatchesScope` helper the rest of the UI uses.
      // The event-router dispatches both fields, so a same-session
      // /different-topic failover (slides/sites subview while the
      // user is on the default view, or vice versa) is now suppressed
      // until the user navigates to that scope.
      if (!eventMatchesScope(detail, activeSessionId, activeTopic)) {
        return;
      }
      keySeq += 1;
      setVisible({ ...detail, key: keySeq });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setVisible(null);
        timer = null;
      }, dismissAfterMs);
    }
    window.addEventListener("crew:router_failover", handle);
    return () => {
      window.removeEventListener("crew:router_failover", handle);
      if (timer) clearTimeout(timer);
    };
  }, [dismissAfterMs, activeSessionId, activeTopic]);

  if (!visible) return null;
  return (
    <div
      data-testid="router-failover-banner"
      role="status"
      aria-live="polite"
      className="glass-pill pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-[12px] px-4 py-2 text-xs text-text shadow-lg"
    >
      <span className="font-semibold">Router switched</span>
      <span className="ml-1.5 text-muted/85">
        {visible.from} → {visible.to}
      </span>
      <span className="ml-2 text-muted/70">
        ({visible.reason}, {visible.elapsedMs}ms)
      </span>
    </div>
  );
}
