/**
 * Conversation view for the home assistant UI.
 *
 * Large-font chat bubbles optimised for arm's-length reading (>1 m).
 * Reuses OctosRuntimeProvider + ThreadStore for message state, and
 * `bridgeSend` for the WS send path.
 *
 * Auto-returns to standby after `IDLE_RETURN_SECONDS` of inactivity
 * (no user input, no streaming).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ArrowLeft, SendHorizontal } from "lucide-react";
import { useSession } from "@/runtime/session-context";
import { useThreads, type Thread, type ThreadMessage } from "@/store/thread-store";
import { sendMessage as bridgeSend } from "@/runtime/ui-protocol-send";
import { HOME_STRINGS } from "./constants";

interface ConversationViewProps {
  onBack: () => void;
}

/** Idle-return timer duration in ms. */
const IDLE_MS = HOME_STRINGS.idleReturnSeconds * 1000;

function formatBubbleTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ConversationView({ onBack }: ConversationViewProps) {
  const { currentSessionId, historyTopic, refreshSessions, markSessionActive } = useSession();
  const threads = useThreads(currentSessionId, historyTopic);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composingRef = useRef(false);

  // ── Idle return ─────────────────────────────────────────────────
  const resetIdle = useCallback(() => {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(onBack, IDLE_MS);
  }, [onBack]);

  useEffect(() => {
    resetIdle();
    return () => clearTimeout(idleTimerRef.current);
  }, [resetIdle]);

  // Any new thread data (assistant reply) resets the idle timer.
  useEffect(() => {
    resetIdle();
  }, [threads, resetIdle]);

  // ── Auto-scroll ─────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threads]);

  // ── Send ────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    resetIdle();

    bridgeSend({
      sessionId: currentSessionId,
      historyTopic,
      text: trimmed,
      requestText: trimmed,
      media: [],
      onSessionActive: (firstMsg) => markSessionActive(firstMsg),
      onComplete: () => {
        void refreshSessions();
      },
    });

    setText("");
    setSending(false);
  }, [text, sending, currentSessionId, historyTopic, refreshSessions, markSessionActive, resetIdle]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
      resetIdle();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend, resetIdle],
  );

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, [text]);

  // ── Determine streaming state ──────────────────────────────────
  const isStreaming = threads.some(
    (t: Thread) =>
      t.pendingAssistant !== null &&
      t.pendingAssistant.status === "streaming",
  );

  return (
    <div className="home-conversation flex h-full w-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 px-4 py-3">
        <button
          onClick={onBack}
          className="home-back-button flex items-center justify-center rounded-xl"
          aria-label={HOME_STRINGS.backToStandby}
        >
          <ArrowLeft size={24} className="text-white/70" />
        </button>
        <div className="flex-1" />
        {isStreaming && (
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
            <span className="text-sm text-white/50">Thinking</span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="home-messages flex-1 overflow-y-auto px-4 pb-4"
        onTouchStart={resetIdle}
        onMouseMove={resetIdle}
      >
        {threads.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <span className="text-xl text-white/30">
              {HOME_STRINGS.inputPlaceholder}
            </span>
          </div>
        )}
        {threads.map((thread: Thread) => (
          <div key={thread.id} className="mb-4">
            {/* User bubble */}
            {thread.userMsg && (
              <div className="flex justify-end mb-2">
                <div className="home-bubble home-bubble-user max-w-[80%] rounded-2xl px-5 py-3">
                  <div className="home-bubble-text text-white">
                    {thread.userMsg.text}
                  </div>
                  <div className="mt-1 text-right text-xs text-white/30 tabular-nums">
                    {formatBubbleTime(thread.userMsg.timestamp)}
                  </div>
                </div>
              </div>
            )}

            {/* Assistant bubbles (completed responses) */}
            {thread.responses
              .filter((msg: ThreadMessage) => msg.role === "assistant")
              .map((msg: ThreadMessage) => (
              <div key={msg.id} className="flex justify-start mb-2">
                <div className="home-bubble home-bubble-assistant max-w-[80%] rounded-2xl px-5 py-3">
                  <div className="home-bubble-text text-white/90">
                    {msg.text}
                  </div>
                  <div className="mt-1 text-xs text-white/30 tabular-nums">
                    {formatBubbleTime(msg.timestamp)}
                  </div>
                </div>
              </div>
            ))}

            {/* Pending streaming */}
            {thread.pendingAssistant &&
              thread.pendingAssistant.text && (
                <div className="flex justify-start mb-2">
                  <div className="home-bubble home-bubble-assistant max-w-[80%] rounded-2xl px-5 py-3">
                    <div className="home-bubble-text text-white/90">
                      {thread.pendingAssistant.text}
                    </div>
                  </div>
                </div>
              )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 pb-4 pt-2">
        <div className="home-composer flex items-end gap-3 rounded-2xl p-3">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              resetIdle();
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder={HOME_STRINGS.inputPlaceholder}
            rows={1}
            className="home-composer-input flex-1 resize-none bg-transparent px-3 py-3 outline-none"
            autoFocus
          />
          <button
            onClick={() => void handleSend()}
            disabled={text.trim().length === 0 || sending}
            className="home-send-button flex shrink-0 items-center justify-center rounded-xl disabled:opacity-30"
            aria-label={HOME_STRINGS.send}
          >
            <SendHorizontal size={22} className="text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}
