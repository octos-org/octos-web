import { useEffect, type CSSProperties } from "react";
import { Camera, CameraOff, Settings, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useVoiceConversation, type VoiceState } from "./use-voice-conversation";
import { VoiceOrb } from "./voice-orb";
import { CameraPreview } from "./camera-preview";
import { VisualPanel } from "./visual-panel";
import { unlockAudio } from "./audio-playback";
import { useOminixRuntimeSummary } from "../use-ominix-runtime-summary";
import "./voice.css";

const STATE_WORD: Record<VoiceState, string> = {
  idle: "点光球开始说话",
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
  // UPCR-2026-025: a spoken exit intent ("再见 / 退出 / 静音") leaves the voice
  // screen via the same destination as the manual X button — the hook fires it
  // only AFTER the farewell audio finishes.
  const conv = useVoiceConversation(sessionId, historyTopic, onBack);
  const navigate = useNavigate();
  const runtime = useOminixRuntimeSummary();

  // Auto-enter listening on mount: the user reached this full-screen view via a
  // navigation gesture, so unlock audio playback and begin capture immediately
  // instead of requiring an extra orb tap. Do not suppress StrictMode's second
  // effect pass: useVoiceConversation owns an unmount cleanup, so the first
  // dev-only pass can be stopped before the second pass becomes the live one.
  useEffect(() => {
    if (runtime.ready) {
      unlockAudio();
      void conv.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.ready]);

  const openOminixSettings = () => {
    navigate("/settings?tab=ominix");
  };
  const visibleTurns = conv.turns.slice(-3);

  const onOrbClick = () => {
    if (!runtime.ready) {
      if (!runtime.loading) openOminixSettings();
      return;
    }
    // Backup audio unlock: if the entry gesture didn't stick, tapping the orb
    // is another gesture that unlocks playback for subsequent replies.
    unlockAudio();
    if (conv.state === "speaking" || conv.state === "thinking") conv.interrupt();
    else if (conv.state === "idle" || conv.state === "error") void conv.start();
  };

  return (
    <div className="voice-view relative flex h-full w-full bg-black">
      {/* Conversation column (orb + camera UI + text). Full width on its own;
          shrinks to the left when a visual is docked on the right so the user
          can keep talking while referencing it. */}
      <div className="relative flex flex-1 flex-col items-center justify-center min-w-0">
        <button
          onClick={onBack}
          aria-label="exit voice mode"
          className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/70"
        >
          <X size={22} />
        </button>

        <button
          onClick={() => conv.toggleCamera()}
          aria-label="toggle camera"
          aria-pressed={conv.cameraActive}
          className="absolute left-5 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/70"
        >
          {conv.cameraActive ? <Camera size={20} /> : <CameraOff size={20} />}
        </button>

        {/* Self-preview: show the user what the AI sees (continuous live feed). */}
        {conv.cameraActive && conv.cameraStream && (
          <div className="absolute left-1/2 top-5 flex -translate-x-1/2 flex-col items-center gap-1">
            <div className="relative">
              <CameraPreview stream={conv.cameraStream} />
              {/* One-shot border flash each time a frame is sent (keyed by URL). */}
              {conv.lastSentFrameUrl && (
                <span
                  key={conv.lastSentFrameUrl}
                  className="cam-sent-flash pointer-events-none absolute inset-0 rounded-xl"
                />
              )}
            </div>
            <span className="text-[10px] text-white/40">实时画面</span>
          </div>
        )}

        {/* The exact frame sent to the AI this turn (model's view, not mirrored). */}
        {conv.lastSentFrameUrl && (
          <div
            key={conv.lastSentFrameUrl}
            className="cam-sent-pop absolute bottom-4 left-4 flex flex-col items-center gap-1"
          >
            <img
              src={conv.lastSentFrameUrl}
              alt="frame sent to AI"
              className="h-20 w-[107px] rounded-lg object-cover ring-1 ring-white/15 shadow-lg"
            />
            <span className="text-[10px] text-white/40">已发给 AI</span>
          </div>
        )}

        <div
          onClick={onOrbClick}
          role="button"
          aria-label={runtime.ready ? "voice orb" : "open OMiniX settings"}
        >
          <VoiceOrb state={runtime.ready ? conv.state : "error"} />
        </div>

        {/* Surface the readiness pill only when something is wrong; a ready
            engine is used silently. */}
        {runtime.needsAttention && (
          <div className={`voice-runtime-pill is-${runtime.tone}`}>
            {runtime.label}
          </div>
        )}

        <div className="mt-6 min-h-[20px] text-sm text-white/55">
          {runtime.ready
            ? conv.exiting
              ? "再见 👋"
              : STATE_WORD[conv.state]
            : runtime.loading
              ? /* still checking — stay silent, the pill is hidden too */ ""
              : "语音引擎未就绪，请先在 Settings 里安装或修复 OMiniX。"}
        </div>

        {runtime.ready && conv.error && (
          <div className="voice-error-panel" role="alert">
            {conv.error}
          </div>
        )}

        {!runtime.ready && !runtime.loading && (
          <button
            type="button"
            onClick={openOminixSettings}
            className="voice-runtime-action"
          >
            <Settings size={15} />
            打开 OMiniX 设置
          </button>
        )}

        {/* Camera on but stream not ready yet, or it failed. */}
        {conv.cameraActive && !conv.cameraStream && (
          <div className="mt-1 text-xs text-white/40">摄像头开启中…</div>
        )}
        {conv.cameraError && (
          <div className="mt-1 text-xs text-red-300/70">摄像头不可用，已切回纯语音</div>
        )}

        <div className="voice-transcript-stack absolute inset-x-0 bottom-6 mx-auto w-full max-w-[min(760px,86vw)] px-6">
          {visibleTurns.map((turn, index) => {
            const age = visibleTurns.length - index - 1;
            const hasUserText = turn.userText || turn.awaitingTranscript;
            const hasAssistantText = turn.assistantText.length > 0;
            return (
              <div
                key={turn.id}
                className="voice-transcript-turn"
                style={
                  {
                    "--voice-turn-y": `${age * -8}px`,
                    "--voice-turn-opacity": String(1 - age * 0.34),
                    "--voice-turn-scale": String(1 - age * 0.035),
                    "--voice-turn-blur": `${age * 0.18}px`,
                  } as CSSProperties
                }
              >
                {hasUserText && (
                  <div className="voice-transcript-user">
                    {turn.userText || "正在识别…"}
                  </div>
                )}
                {hasAssistantText && (
                  <div className="voice-transcript-assistant">
                    {turn.assistantText}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Rich output: generating indicator while a visual is being produced.
            Shown even when a prior visual is still docked on the right, so a
            follow-up turn that generates a NEW visual still signals progress. */}
        {conv.generating && (
          <div className="mt-5 flex items-center gap-2 text-sm text-white/60">
            <span className="h-2 w-2 animate-ping rounded-full bg-white/70" />
            正在生成视觉内容…
          </div>
        )}
      </div>

      {/* Rich output: produced image / interactive HTML, docked on the right so
          the next turn can be spoken while looking at it. */}
      {conv.visual && (
        <div className="h-full w-[55%] shrink-0 border-l border-white/10">
          <VisualPanel
            key={conv.visual.path}
            visual={conv.visual}
            sessionId={sessionId}
            onClose={conv.dismissVisual}
          />
        </div>
      )}
    </div>
  );
}
