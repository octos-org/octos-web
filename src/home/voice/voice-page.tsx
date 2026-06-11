/**
 * VoicePage — standalone `/voice` route for the on-device voice assistant.
 *
 * Independent of the `/home` assistant dashboard: it owns its OWN session
 * scope (a dedicated `VOICE_SESSION_KEY` + `voice` history topic) so voice
 * turns never bleed into the home or chat conversations. The scope is wired
 * exactly like `HomeAssistantPage` — a `SessionContext.Provider` plus a
 * `ScopedRuntimeBridge` that connects the WS bridge for this session — but
 * the body is just our full-screen `VoiceView` (orb + ominix STT/TTS
 * pipeline). Entry point lives on the root page (`/`).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScopedRuntimeBridge } from "@/runtime/runtime-provider";
import {
  SessionContext,
  useModeState,
  type QueueMode,
  type AdaptiveMode,
} from "@/runtime/session-context";
import * as ThreadStore from "@/store/thread-store";
import { VoiceView } from "./voice-view";

const VOICE_SESSION_KEY = "octos_voice_session_id";
const VOICE_HISTORY_TOPIC = "voice";

function generateSessionId(): string {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function VoicePage() {
  const navigate = useNavigate();

  // Dedicated, persistent voice session — isolated from /home and /chat.
  const voiceSessionId = useMemo(() => {
    const stored = localStorage.getItem(VOICE_SESSION_KEY);
    if (stored) return stored;
    const id = generateSessionId();
    localStorage.setItem(VOICE_SESSION_KEY, id);
    return id;
  }, []);

  const { queueMode, adaptiveMode } = useModeState(
    voiceSessionId,
    VOICE_HISTORY_TOPIC,
  );

  // Load this session's history on mount; retry when the bridge reconnects.
  useEffect(() => {
    void ThreadStore.loadHistory(voiceSessionId, VOICE_HISTORY_TOPIC);
    const onBridgeReady = () => {
      void ThreadStore.loadHistory(voiceSessionId, VOICE_HISTORY_TOPIC, {
        force: true,
      });
    };
    window.addEventListener("crew:bridge_connected", onBridgeReady);
    return () => {
      window.removeEventListener("crew:bridge_connected", onBridgeReady);
    };
  }, [voiceSessionId]);

  const [activeTask, setActiveTask] = useState(false);
  const setServerTaskActive = useCallback(
    (_sessionId: string, active: boolean) => setActiveTask(active),
    [],
  );

  const sessionValue = useMemo(
    () => ({
      sessions: [],
      currentSessionId: voiceSessionId,
      historyTopic: VOICE_HISTORY_TOPIC,
      currentSessionTitle: "Voice",
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
      createSession: () => voiceSessionId,
      removeSession: async () => {},
      refreshSessions: async () => {},
      markSessionActive: () => {},
    }),
    [voiceSessionId, activeTask, queueMode, adaptiveMode, setServerTaskActive],
  );

  return (
    <div className="home-root relative h-screen w-screen overflow-hidden">
      <SessionContext.Provider value={sessionValue}>
        <ScopedRuntimeBridge>
          <VoiceView
            sessionId={voiceSessionId}
            historyTopic={VOICE_HISTORY_TOPIC}
            onBack={() => navigate("/")}
          />
        </ScopedRuntimeBridge>
      </SessionContext.Provider>
    </div>
  );
}
