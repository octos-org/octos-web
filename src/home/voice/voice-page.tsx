/**
 * VoicePage — standalone `/voice` route for the on-device voice assistant.
 *
 * Independent of the `/home` assistant dashboard: it owns its OWN session
 * scope (a fresh `voice-*` session for every entry) so voice turns never
 * bleed into the home or chat conversations. The scope is wired
 * exactly like `HomeAssistantPage` — a `SessionContext.Provider` plus a
 * `ScopedRuntimeBridge` that connects the WS bridge for this session — but
 * the body is just our full-screen `VoiceView` (orb + ominix STT/TTS
 * pipeline). Entry points: the /home standby orb and the nav Voice
 * shortcut; the X button and the spoken "goodbye" return to the entry
 * (see `octos_voice_entry` in sessionStorage).
 */

import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ScopedRuntimeBridge } from "@/runtime/runtime-provider";
import { UiProtocolQuestionHost } from "@/components/ui-protocol-question-host";
import {
  SessionContext,
  useModeState,
  type QueueMode,
  type AdaptiveMode,
} from "@/runtime/session-context";
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

  // Return to wherever the user entered from (/home standby orb, or the
  // nav shortcut → workspace root). The entry is recorded by the
  // standby views before navigating here; absent it, fall back to "/".
  const handleBack = useCallback(() => {
    const entry = sessionStorage.getItem("octos_voice_entry");
    sessionStorage.removeItem("octos_voice_entry");
    navigate(entry && entry.startsWith("/") ? entry : "/");
  }, [navigate]);

  // Dedicated, per-entry voice session — isolated from /home and /chat.
  const voiceSessionId = useMemo(() => {
    const id = generateSessionId();
    localStorage.removeItem(VOICE_SESSION_KEY);
    return id;
  }, []);

  const { queueMode, adaptiveMode } = useModeState(voiceSessionId);

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
      branchSession: async () => {
        throw new Error("session fork is not available on this surface");
      },
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
            onBack={handleBack}
          />
          <UiProtocolQuestionHost />
        </ScopedRuntimeBridge>
      </SessionContext.Provider>
    </div>
  );
}
