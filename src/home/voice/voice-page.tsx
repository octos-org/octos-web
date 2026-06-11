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
// NB: intentionally NO history topic. Isolation comes from the dedicated
// `voiceSessionId` alone. A topic would make the bridge subscribe on the
// topic-suffixed key (`<id>#<topic>`), but the server broadcasts background
// `file/attached` events (the streamed TTS reply audio) on the BASE session
// key — so a topic-scoped subscription receives zero audio and the orb hangs
// in "thinking". Staying topic-less keeps the subscription on the base key
// where the reply audio is actually published.

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

  const { queueMode, adaptiveMode } = useModeState(voiceSessionId);

  // Load this session's history on mount; retry when the bridge reconnects.
  useEffect(() => {
    void ThreadStore.loadHistory(voiceSessionId);
    const onBridgeReady = () => {
      void ThreadStore.loadHistory(voiceSessionId, undefined, {
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
      historyTopic: "",
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
            onBack={() => navigate("/")}
          />
        </ScopedRuntimeBridge>
      </SessionContext.Provider>
    </div>
  );
}
