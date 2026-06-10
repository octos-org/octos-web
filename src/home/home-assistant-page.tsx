/**
 * Home Assistant full-screen page -- `/home` route.
 *
 * Two modes:
 *   1. **Standby** -- large clock, weather, quick-action cards.
 *   2. **Conversation** -- large-font chat bubbles with auto-idle return.
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
 *
 * Night mode: dims display and hides non-essential UI between 22:00
 * and 06:00 (auto), or always/never based on user setting. Touch/mouse
 * activity temporarily restores normal brightness for 5 seconds.
 */

import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { OctosRuntimeProvider } from "@/runtime/runtime-provider";
import { useSession } from "@/runtime/session-context";
import { useWakeLock } from "./use-wake-lock";
import { StandbyView } from "./standby-view";
import { ConversationView } from "./conversation-view";
import {
  HomeSettingsProvider,
  useHomeSettings,
} from "./home-settings-context";
import { useClock } from "./use-clock";

type Mode = "standby" | "conversation";

const HOME_SESSION_KEY = "octos_home_session_id";
const HOME_SESSION_TITLE = "Home Assistant";

/** Duration in ms to temporarily suppress night mode on interaction. */
const NIGHT_SUPPRESS_MS = 5000;

/**
 * Night-mode logic hook.
 * Returns `true` when the display should be in night mode.
 */
function useNightMode(): boolean {
  const { nightMode } = useHomeSettings();
  const clock = useClock();
  const [suppressed, setSuppressed] = useState(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Determine raw night state
  const rawNight = useMemo(() => {
    if (nightMode === "on") return true;
    if (nightMode === "off") return false;
    // auto: 22:00 - 06:00
    const h = clock.date.getHours();
    return h >= 22 || h < 6;
  }, [nightMode, clock.date]);

  // Suppress on user activity
  useEffect(() => {
    if (!rawNight) return;

    const handler = () => {
      setSuppressed(true);
      clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = setTimeout(
        () => setSuppressed(false),
        NIGHT_SUPPRESS_MS,
      );
    };

    window.addEventListener("mousemove", handler);
    window.addEventListener("touchstart", handler);
    return () => {
      window.removeEventListener("mousemove", handler);
      window.removeEventListener("touchstart", handler);
      clearTimeout(suppressTimerRef.current);
    };
  }, [rawNight]);

  return rawNight && !suppressed;
}

/**
 * Inner shell that lives inside OctosRuntimeProvider so it can access
 * the SessionContext. Handles session creation/restoration and the
 * standby/conversation mode toggle.
 */
function HomeAssistantShell() {
  const { currentSessionId, createSession, switchSession } = useSession();
  const [mode, setMode] = useState<Mode>("standby");
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const initRef = useRef(false);
  const nightActive = useNightMode();

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

  const activate = useCallback((cardPrefill?: string) => {
    setPrefill(cardPrefill);
    setMode("conversation");
  }, []);

  const deactivate = useCallback(() => {
    setPrefill(undefined);
    setMode("standby");
  }, []);

  return (
    <div className={nightActive ? "home-night-mode" : ""}>
      {/* Standby layer */}
      <div
        className={`home-layer absolute inset-0 transition-all duration-500 ease-in-out ${
          mode === "standby"
            ? "opacity-100 scale-100 pointer-events-auto z-10"
            : "opacity-0 scale-[0.98] pointer-events-none z-0"
        }`}
      >
        <StandbyView onActivate={activate} nightActive={nightActive} />
      </div>

      {/* Conversation layer */}
      <div
        className={`home-layer absolute inset-0 transition-all duration-500 ease-in-out ${
          mode === "conversation"
            ? "opacity-100 scale-100 pointer-events-auto z-10"
            : "opacity-0 scale-[0.98] pointer-events-none z-0"
        }`}
      >
        <ConversationView onBack={deactivate} prefill={prefill} />
      </div>
    </div>
  );
}

export function HomeAssistantPage() {
  useWakeLock();

  return (
    <div className="home-root relative h-screen w-screen overflow-hidden">
      <HomeSettingsProvider>
        <OctosRuntimeProvider>
          <HomeAssistantShell />
        </OctosRuntimeProvider>
      </HomeSettingsProvider>
    </div>
  );
}
