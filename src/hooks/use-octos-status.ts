import { useEffect, useRef, useState } from "react";
import { getStatus } from "@/api/sessions";
import type { ServerStatus } from "@/api/types";

export function useOctosStatus(intervalMs = 30000) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const s = await getStatus();
        if (mounted) setStatus(s);
      } catch {
        // ignore
      }
    }

    function startPolling() {
      poll();
      intervalRef.current = setInterval(poll, intervalMs);
    }

    function stopPolling() {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    // Only poll when tab is visible
    function onVisibilityChange() {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    }

    if (!document.hidden) {
      startPolling();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mounted = false;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);

  return status;
}
