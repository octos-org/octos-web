import { useEffect } from "react";
import { X } from "lucide-react";
import { useVoiceConversation, type VoiceState } from "./use-voice-conversation";
import { VoiceOrb } from "./voice-orb";
import { VoiceSelector } from "./voice-selector";
import { unlockAudio } from "./audio-playback";
import "./voice.css";

const STATE_WORD: Record<VoiceState, string> = {
  idle: "",
  listening: "聆听中…",
  thinking: "思考中…",
  speaking: "说话中…",
  error: "出错了，点光球重试",
};

interface VoiceViewProps {
  sessionId: string;
  historyTopic?: string;
  onBack: () => void;
}

export function VoiceView({ sessionId, historyTopic, onBack }: VoiceViewProps) {
  const conv = useVoiceConversation(sessionId, historyTopic);

  useEffect(() => {
    void conv.start();
    return () => conv.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onOrbClick = () => {
    // Backup audio unlock: if the entry gesture didn't stick, tapping the orb
    // is another gesture that unlocks playback for subsequent replies.
    unlockAudio();
    if (conv.state === "speaking" || conv.state === "thinking") conv.interrupt();
    else if (conv.state === "error") void conv.start();
  };

  return (
    <div className="voice-view relative flex h-full w-full flex-col items-center justify-center">
      <button
        onClick={onBack}
        aria-label="exit voice mode"
        className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/70"
      >
        <X size={22} />
      </button>

      <div onClick={onOrbClick} role="button" aria-label="voice orb">
        <VoiceOrb state={conv.state} />
      </div>

      <div className="mt-6 min-h-[20px] text-sm text-white/55">{STATE_WORD[conv.state]}</div>

      <div className="mt-4 max-w-[80%] text-center">
        {conv.lastUserText && (
          <div className="mb-2 text-sm text-white/45">{conv.lastUserText}</div>
        )}
        {conv.lastAssistantText && (
          <div className="text-lg leading-relaxed text-white/90">{conv.lastAssistantText}</div>
        )}
      </div>

      {/* Quick voice switcher — same store as the settings panel. */}
      <div className="absolute inset-x-0 bottom-6 px-6">
        <VoiceSelector />
      </div>
    </div>
  );
}
