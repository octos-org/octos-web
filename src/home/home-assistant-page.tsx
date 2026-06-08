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
 */

import { useState, useCallback } from "react";
import { OctosRuntimeProvider } from "@/runtime/runtime-provider";
import { useWakeLock } from "./use-wake-lock";
import { StandbyView } from "./standby-view";
import { ConversationView } from "./conversation-view";

type Mode = "standby" | "conversation";

export function HomeAssistantPage() {
  const [mode, setMode] = useState<Mode>("standby");

  useWakeLock();

  const activate = useCallback(() => setMode("conversation"), []);
  const deactivate = useCallback(() => setMode("standby"), []);

  return (
    <div className="home-root relative h-screen w-screen overflow-hidden">
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

      {/* Conversation layer — always mounted inside Runtime so session
          stays warm, but visibility is toggled via CSS. */}
      <div
        className={`home-layer absolute inset-0 transition-opacity duration-500 ease-in-out ${
          mode === "conversation"
            ? "opacity-100 pointer-events-auto z-10"
            : "opacity-0 pointer-events-none z-0"
        }`}
      >
        <OctosRuntimeProvider>
          <ConversationView onBack={deactivate} />
        </OctosRuntimeProvider>
      </div>
    </div>
  );
}
