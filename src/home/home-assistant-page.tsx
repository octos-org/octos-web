/**
 * Home Assistant full-screen page — `/home` route.
 *
 * Two modes:
 *   1. **Standby** — large clock, weather, quick-action cards.
 *   2. **Conversation** — large-font chat bubbles with auto-idle return.
 *
 * The page is always full-screen (no sidebar, no top nav). It wraps
 * OctosRuntimeProvider so the conversation view can read from
 * ThreadStore and send via the WS bridge.
 *
 * Wake Lock is acquired while mounted to prevent screen-off on idle
 * touch devices.
 *
 * Session management: Home UI uses a single persistent session stored
 * in `localStorage` under `octos_home_session_id`. On mount the shell
 * either resumes that session or creates a fresh one titled
 * "Home Assistant", then switches the SessionContext to it so the WS
 * bridge connects to the right session.
 */

import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { OctosRuntimeProvider } from "@/runtime/runtime-provider";
import { useSession } from "@/runtime/session-context";
import { useWakeLock } from "./use-wake-lock";
import { StandbyView } from "./standby-view";
import { ConversationView } from "./conversation-view";

type Mode = "standby" | "conversation";

const HOME_SESSION_KEY = "octos_home_session_id";
const HOME_SESSION_TITLE = "Home Assistant";

/**
 * Inner shell that lives inside OctosRuntimeProvider so it can access
 * the SessionContext. Handles session creation/restoration and the
 * standby/conversation mode toggle.
 */
function HomeAssistantShell() {
  const { currentSessionId, createSession, switchSession } = useSession();
  const [mode, setMode] = useState<Mode>("standby");
  const initRef = useRef(false);

  // Resolve the target home session id synchronously during render
  // (no setState in an effect). `createSession` is safe to call during
  // render because it only mutates context state + localStorage.
  const homeSessionId = useMemo(() => {
    const storedId = localStorage.getItem(HOME_SESSION_KEY);
    if (storedId) return storedId;

    const newId = createSession(HOME_SESSION_TITLE);
    localStorage.setItem(HOME_SESSION_KEY, newId);
    return newId;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot init
  }, []);

  // Side-effect: switch to the home session if the context is pointing
  // elsewhere. Runs once after mount (initRef guard).
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    if (homeSessionId !== currentSessionId) {
      switchSession(homeSessionId);
    }
  }, [homeSessionId, currentSessionId, switchSession]);

  const activate = useCallback(() => setMode("conversation"), []);
  const deactivate = useCallback(() => setMode("standby"), []);

  return (
    <>
      {/* Standby layer */}
      <div
        className={`home-layer absolute inset-0 transition-opacity duration-500 ease-in-out ${
          mode === "standby"
            ? "opacity-100 pointer-events-auto z-10"
            : "opacity-0 pointer-events-none z-0"
        }`}
      >
        <StandbyView onActivate={activate} />
      </div>

      {/* Conversation layer */}
      <div
        className={`home-layer absolute inset-0 transition-opacity duration-500 ease-in-out ${
          mode === "conversation"
            ? "opacity-100 pointer-events-auto z-10"
            : "opacity-0 pointer-events-none z-0"
        }`}
      >
        <ConversationView onBack={deactivate} />
      </div>
    </>
  );
}

export function HomeAssistantPage() {
  useWakeLock();

  return (
    <div className="home-root relative h-screen w-screen overflow-hidden">
      <OctosRuntimeProvider>
        <HomeAssistantShell />
      </OctosRuntimeProvider>
    </div>
  );
}
