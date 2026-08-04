/**
 * "Connection lost" banner for chat surfaces.
 *
 * The session bridge tracks its connection state internally (send-queue
 * gating, reconnect backoff) but until now nothing RENDERED it: a dead
 * backend or dropped network looked identical to a slow one — the message
 * just hung until the 30s ghost timeout, whose copy then blamed the model
 * config. This banner surfaces the two states the user can act on:
 *
 *  - `reconnecting` — the WS dropped after a successful session and the
 *    bridge is retrying with backoff. Sends queue silently; say so.
 *  - `closed`/`error` after having been connected — the reconnect budget
 *    is spent; sends now fast-fail. Offer a reload (a fresh page re-runs
 *    the whole bootstrap, the only reliable recovery at that point).
 *
 * Deliberately silent during the initial `connecting` handshake — flashing
 * a warning on every navigation would be worse than no banner.
 *
 * The bridge only learns about a blackholed network from its keepalive
 * (up to ~60s of silence), so the banner ALSO listens to the browser's
 * online/offline events: a local network drop gets an instant signal
 * instead of looking like a slow minute.
 */

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { onActiveConnectionStateChange } from "@/runtime/ui-protocol-runtime";

type NoticeKind = "offline" | "reconnecting" | "lost";

const COPY: Record<NoticeKind, string> = {
  offline: "You're offline — messages will send when the network returns.",
  reconnecting:
    "Connection lost — reconnecting. New messages will send when it's back.",
  lost: "Connection to the server was lost and couldn't be restored.",
};

export function ConnectionNotice(): React.ReactElement | null {
  const [bridgeNotice, setBridgeNotice] = useState<NoticeKind | null>(null);
  const [offline, setOffline] = useState<boolean>(() => !navigator.onLine);
  // Only a drop AFTER a successful connect is worth surfacing. Tracks the
  // lifetime of the subscription, not the mount: a session switch re-emits
  // "connecting" → "connected" and re-arms the gate naturally.
  const wasConnectedRef = useRef(false);

  useEffect(() => {
    return onActiveConnectionStateChange((state) => {
      if (state === "connected") {
        wasConnectedRef.current = true;
        setBridgeNotice(null);
        return;
      }
      if (!wasConnectedRef.current) {
        // Initial handshake or no bridge yet — stay silent.
        return;
      }
      if (state === "reconnecting") {
        setBridgeNotice("reconnecting");
      } else if (state === "closed" || state === "error") {
        setBridgeNotice("lost");
      } else {
        // "connecting"/"idle" after a drop: the bridge is mid-recovery —
        // keep the current notice rather than flicker.
      }
    });
  }, []);

  useEffect(() => {
    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // A local network drop outranks whatever the bridge last knew — its
  // keepalive won't have noticed yet, and "offline" names the real cause.
  const notice =
    offline && wasConnectedRef.current ? "offline" : bridgeNotice;

  if (!notice) return null;

  return (
    <div
      data-testid="connection-notice"
      data-connection-notice={notice}
      role="alert"
      className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-[10px] border border-(--workbench-warning-border) bg-(--workbench-warning-bg) px-3 py-2 text-xs text-(--workbench-warning-text)"
    >
      <span className="min-w-0 flex-1">{COPY[notice]}</span>
      {notice === "lost" && (
        <button
          type="button"
          data-testid="connection-notice-reload"
          onClick={() => window.location.reload()}
          className="flex shrink-0 items-center gap-1 rounded-md border border-(--workbench-warning-border) px-2 py-1 font-medium hover:underline"
        >
          <RefreshCw size={12} />
          Reload
        </button>
      )}
    </div>
  );
}
