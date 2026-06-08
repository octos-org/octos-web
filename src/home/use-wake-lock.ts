/**
 * Wake Lock hook — keeps the screen on while the home assistant UI
 * is displayed. Uses the Screen Wake Lock API (W3C).
 *
 * Automatically re-acquires on `visibilitychange` because the browser
 * releases the lock when the tab is backgrounded.
 */

import { useEffect, useRef } from "react";

export function useWakeLock(): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function acquire() {
      if (cancelled) return;
      if (!("wakeLock" in navigator)) return;
      try {
        lockRef.current = await navigator.wakeLock.request("screen");
      } catch {
        // User-agent denied or API unavailable — non-fatal.
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void acquire();
      }
    }

    void acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (lockRef.current) {
        void lockRef.current.release().catch(() => {});
        lockRef.current = null;
      }
    };
  }, []);
}
