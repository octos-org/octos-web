import type { VoiceState } from "@/home/voice/use-voice-conversation";

const STATE_LABEL: Record<VoiceState, string> = {
  idle: "轻触开始",
  listening: "我在听",
  thinking: "正在想",
  speaking: "正在讲",
  error: "轻触重试",
};

export function OctosTeacher({
  state,
  speech,
  onClick,
}: {
  state: VoiceState;
  speech: string;
  onClick: () => void;
}) {
  return (
    <div className="octos-teacher">
      {speech && (
        <div className="octos-teacher-caption" aria-live="polite">
          {speech}
        </div>
      )}
      <button
        type="button"
        className="octos-teacher-avatar"
        data-state={state}
        onClick={onClick}
        aria-label={
          state === "speaking" || state === "thinking"
            ? "打断 Octos"
            : "和 Octos 说话"
        }
      >
        <span className="octos-teacher-halo" />
        <span className="octos-teacher-emoji" aria-hidden="true">
          🐙
        </span>
        <span className="octos-teacher-state">{STATE_LABEL[state]}</span>
      </button>
    </div>
  );
}
