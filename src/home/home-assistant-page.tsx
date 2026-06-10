/**
 * Home Assistant full-screen page -- `/home` route.
 *
 * Two modes:
 *   1. **Standby** -- large clock, weather, quick-action cards.
 *   2. **Conversation** -- large-font chat bubbles with auto-idle return.
 *
 * The page is always full-screen (no sidebar, no top nav).
 *
 * Session architecture follows the scoped pattern from Sites/Slides:
 * manual `SessionContext.Provider` + `ScopedRuntimeBridge`, with a
 * dedicated `historyTopic` ("home") to isolate home messages from the
 * main chat. The WS bridge, task watcher, and file-store loaders are
 * wired by `ScopedRuntimeBridge`; the session context is constructed
 * here with stubs for methods the home surface doesn't use.
 *
 * Wake Lock is acquired while mounted to prevent screen-off on idle
 * touch devices.
 *
 * Night mode: dims display and hides non-essential UI between 22:00
 * and 06:00 (auto), or always/never based on user setting. Touch/mouse
 * activity temporarily restores normal brightness for 5 seconds.
 */

import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { ScopedRuntimeBridge } from "@/runtime/runtime-provider";
import {
  SessionContext,
  useModeState,
  type QueueMode,
  type AdaptiveMode,
} from "@/runtime/session-context";
import { UiProtocolApprovalHost } from "@/components/ui-protocol-approval-host";
import * as ThreadStore from "@/store/thread-store";
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
const HOME_HISTORY_TOPIC = "home";

/** Duration in ms to temporarily suppress night mode on interaction. */
const NIGHT_SUPPRESS_MS = 5000;

function generateSessionId(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

  const rawNight = useMemo(() => {
    if (nightMode === "on") return true;
    if (nightMode === "off") return false;
    const h = clock.date.getHours();
    return h >= 22 || h < 6;
  }, [nightMode, clock.date]);

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
 * Inner shell — owns the mode toggle and night-mode state.
 * Lives inside the scoped SessionContext + ScopedRuntimeBridge.
 */
function HomeAssistantShell() {
  const [mode, setMode] = useState<Mode>("standby");
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const nightActive = useNightMode();

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

      <UiProtocolApprovalHost />
    </div>
  );
}

export function HomeAssistantPage() {
  useWakeLock();

  const homeSessionId = useMemo(() => {
    const stored = localStorage.getItem(HOME_SESSION_KEY);
    if (stored) return stored;
    const id = generateSessionId();
    localStorage.setItem(HOME_SESSION_KEY, id);
    return id;
  }, []);

  const { queueMode, adaptiveMode } = useModeState(
    homeSessionId,
    HOME_HISTORY_TOPIC,
  );

  // Load conversation history on mount; retry when bridge reconnects.
  useEffect(() => {
    void ThreadStore.loadHistory(homeSessionId, HOME_HISTORY_TOPIC);
    const onBridgeReady = () => {
      void ThreadStore.loadHistory(homeSessionId, HOME_HISTORY_TOPIC, {
        force: true,
      });
    };
    window.addEventListener("crew:bridge_connected", onBridgeReady);
    return () => {
      window.removeEventListener("crew:bridge_connected", onBridgeReady);
    };
  }, [homeSessionId]);

  const [activeTask, setActiveTask] = useState(false);
  const setServerTaskActive = useCallback(
    (_sessionId: string, active: boolean) => setActiveTask(active),
    [],
  );

  const sessionValue = useMemo(
    () => ({
      sessions: [],
      currentSessionId: homeSessionId,
      historyTopic: HOME_HISTORY_TOPIC,
      currentSessionTitle: "Home Assistant",
      currentSessionStats: null,
      initialMessages: [] as never[],
      activeTaskOnServer: activeTask,
      queueMode: queueMode as QueueMode,
      adaptiveMode: adaptiveMode as AdaptiveMode,
      setServerTaskActive,
      renameSession: () => {},
      updateSessionStats: () => {},
      switchSession: () => {},
      goBack: async () => false,
      createSession: () => homeSessionId,
      removeSession: async () => {},
      refreshSessions: async () => {},
      markSessionActive: () => {},
    }),
    [homeSessionId, activeTask, queueMode, adaptiveMode, setServerTaskActive],
  );

  return (
    <div className="home-root relative h-screen w-screen overflow-hidden">
      <HomeSettingsProvider>
        <SessionContext.Provider value={sessionValue}>
          <ScopedRuntimeBridge>
            <HomeAssistantShell />
          </ScopedRuntimeBridge>
        </SessionContext.Provider>
      </HomeSettingsProvider>
    </div>
  );
}
