/**
 * Conversation view for the home assistant UI.
 *
 * Large-font chat bubbles optimised for arm's-length reading (>1 m).
 * Reuses OctosRuntimeProvider + ThreadStore for message state, and
 * `bridgeSend` for the WS send path.
 *
 * Auto-returns to standby after configurable idle seconds (from settings).
 *
 * Shows suggestion cards when the conversation is empty.
 *
 * Features:
 * - Thinking/streaming indicator (bouncing dots)
 * - Stop/cancel button during streaming
 * - Smart auto-scroll with user-scroll detection
 * - Smooth text streaming animation (useSmooth)
 * - Tool call display (collapsed)
 * - File attachments (audio, image, download)
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  SendHorizontal,
  Square,
  Wrench,
} from "lucide-react";
import { useSession } from "@/runtime/session-context";
import {
  useThreads,
  type Thread,
  type ThreadMessage,
  type MessageFile,
  type ThreadToolCall,
} from "@/store/thread-store";
import { sendMessage as bridgeSend } from "@/runtime/ui-protocol-send";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import { buildAuthenticatedFileUrl } from "@/api/files";
import { useHomeSettings } from "./home-settings-context";
import { useSmooth } from "./use-smooth";

interface ConversationViewProps {
  onBack: () => void;
  prefill?: string;
}

function formatBubbleTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── File type detection ────────────────────────────────────────────
function isAudioFile(file: MessageFile): boolean {
  return /\.(mp3|wav|ogg|webm|m4a|aac|flac|opus)$/i.test(file.filename);
}

function isImageFile(file: MessageFile): boolean {
  return /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(file.filename);
}

// ── Thinking indicator (bouncing dots) ────────────────────────────
function ThinkingBubble() {
  return (
    <div className="flex justify-start mb-2">
      <div className="home-bubble home-bubble-assistant max-w-[80%] rounded-2xl px-5 py-3">
        <div className="home-thinking-dots flex items-center gap-1.5">
          <span className="home-thinking-dot" style={{ animationDelay: "0ms" }} />
          <span className="home-thinking-dot" style={{ animationDelay: "160ms" }} />
          <span className="home-thinking-dot" style={{ animationDelay: "320ms" }} />
          <span className="ml-2 text-base text-white/40">Thinking</span>
        </div>
      </div>
    </div>
  );
}

// ── File attachment renderers ─────────────────────────────────────
function FileAttachment({ file }: { file: MessageFile }) {
  const url = buildAuthenticatedFileUrl(file.path);

  if (isAudioFile(file)) {
    return (
      <div className="home-file-attachment mt-2">
        <audio controls preload="none" className="home-audio-player w-full">
          <source src={url} />
        </audio>
        {file.caption && (
          <div className="mt-1 text-sm text-white/40">{file.caption}</div>
        )}
      </div>
    );
  }

  if (isImageFile(file)) {
    return (
      <div className="home-file-attachment mt-2">
        <img
          src={url}
          alt={file.caption || file.filename}
          className="home-image-attachment max-w-full rounded-xl"
          loading="lazy"
        />
        {file.caption && (
          <div className="mt-1 text-sm text-white/40">{file.caption}</div>
        )}
      </div>
    );
  }

  // Generic file — download link
  return (
    <div className="home-file-attachment mt-2">
      <a
        href={url}
        download={file.filename}
        target="_blank"
        rel="noopener noreferrer"
        className="home-file-download inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
      >
        <Download size={16} className="shrink-0" />
        <span className="truncate">{file.filename}</span>
      </a>
    </div>
  );
}

// ── Tool calls indicator ──────────────────────────────────────────
function ToolCallsIndicator({ toolCalls }: { toolCalls: ThreadToolCall[] }) {
  if (toolCalls.length === 0) return null;
  return (
    <div className="home-tool-indicator mt-2 flex items-center gap-2 text-sm text-white/35">
      <Wrench size={14} />
      <span>Used {toolCalls.length} tool{toolCalls.length > 1 ? "s" : ""}</span>
    </div>
  );
}

// ── Pending assistant bubble with smooth streaming ────────────────
function PendingBubble({ pending }: { pending: ThreadMessage }) {
  const smoothText = useSmooth(
    pending.text,
    pending.status === "streaming",
  );

  if (!smoothText) return null;

  return (
    <div className="flex justify-start mb-2">
      <div className="home-bubble home-bubble-assistant max-w-[80%] rounded-2xl px-5 py-3">
        <div className="home-bubble-text home-bubble-markdown text-white/90">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {smoothText}
          </ReactMarkdown>
        </div>
        {pending.files.length > 0 && (
          <div>
            {pending.files.map((file, i) => (
              <FileAttachment key={`${file.path}-${i}`} file={file} />
            ))}
          </div>
        )}
        {pending.toolCalls.length > 0 && (
          <ToolCallsIndicator toolCalls={pending.toolCalls} />
        )}
      </div>
    </div>
  );
}

export function ConversationView({ onBack, prefill }: ConversationViewProps) {
  const { currentSessionId, historyTopic, refreshSessions, markSessionActive } = useSession();
  const threads = useThreads(currentSessionId, historyTopic);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composingRef = useRef(false);
  const prefillAppliedRef = useRef<string | undefined>(undefined);

  // ── Scroll state ────────────────────────────────────────────────
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // ── Prefill from card action ────────────────────────────────────
  useEffect(() => {
    if (prefill && prefill !== prefillAppliedRef.current) {
      prefillAppliedRef.current = prefill;
      setText(prefill);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [prefill]);

  const { strings, idleSeconds } = useHomeSettings();
  const idleMs = idleSeconds * 1000;

  // ── Idle return ─────────────────────────────────────────────────
  const resetIdle = useCallback(() => {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(onBack, idleMs);
  }, [onBack, idleMs]);

  useEffect(() => {
    resetIdle();
    return () => clearTimeout(idleTimerRef.current);
  }, [resetIdle]);

  // Any new thread data (assistant reply) resets the idle timer.
  useEffect(() => {
    resetIdle();
  }, [threads, resetIdle]);

  // ── Fix #4: setSending(false) when thread state changes ─────────
  const prevThreadSnapshotRef = useRef<{
    pendingCount: number;
    responseCount: number;
  }>({ pendingCount: 0, responseCount: 0 });

  useEffect(() => {
    if (!sending) return;

    const pendingCount = threads.filter(
      (t: Thread) => t.pendingAssistant !== null,
    ).length;
    const responseCount = threads.reduce(
      (sum: number, t: Thread) => sum + t.responses.length,
      0,
    );

    const prev = prevThreadSnapshotRef.current;
    if (
      pendingCount > prev.pendingCount ||
      responseCount > prev.responseCount
    ) {
      setSending(false);
    }
    prevThreadSnapshotRef.current = { pendingCount, responseCount };
  }, [threads, sending]);

  // ── Scroll detection ────────────────────────────────────────────
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 50;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isAtBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      isAtBottomRef.current = true;
      setShowScrollBtn(false);
    }
  }, []);

  // ── Smart auto-scroll ──────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [threads]);

  // ── Send ────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    resetIdle();

    prevThreadSnapshotRef.current = {
      pendingCount: threads.filter(
        (t: Thread) => t.pendingAssistant !== null,
      ).length,
      responseCount: threads.reduce(
        (sum: number, t: Thread) => sum + t.responses.length,
        0,
      ),
    };

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
    // Scroll to bottom on send
    requestAnimationFrame(() => scrollToBottom());
  }, [text, sending, threads, currentSessionId, historyTopic, refreshSessions, markSessionActive, resetIdle, scrollToBottom]);

  // Fill input with a suggestion and send immediately
  const handleSuggestion = useCallback(
    (suggestion: string) => {
      setText(suggestion);
      setSending(true);
      resetIdle();

      bridgeSend({
        sessionId: currentSessionId,
        historyTopic,
        text: suggestion,
        requestText: suggestion,
        media: [],
        onSessionActive: (firstMsg) => markSessionActive(firstMsg),
        onComplete: () => {
          void refreshSessions();
        },
      });

      setText("");
      setSending(false);
    },
    [currentSessionId, historyTopic, refreshSessions, markSessionActive, resetIdle],
  );

  // ── Cancel / Stop ──────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    const bridge = getActiveBridge(currentSessionId, historyTopic);
    if (bridge) {
      const pendingThread = threads.find(
        (t: Thread) =>
          t.pendingAssistant !== null &&
          t.pendingAssistant.status === "streaming",
      );
      if (pendingThread) {
        void bridge.interruptTurn(pendingThread.id, "user cancelled").catch(() => {
          // best-effort: swallow transport errors.
        });
      }
    }
  }, [currentSessionId, historyTopic, threads]);

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

  // Pending assistant with no text yet → show thinking dots
  const isPending = threads.some(
    (t: Thread) =>
      t.pendingAssistant !== null &&
      !t.pendingAssistant.text,
  );

  const isEmpty = threads.length === 0;

  return (
    <div className="home-conversation flex h-full w-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 px-4 py-3">
        <button
          onClick={onBack}
          className="home-back-button flex items-center justify-center rounded-xl"
          aria-label={strings.backToStandby}
        >
          <ArrowLeft size={24} className="text-white/70" />
        </button>
        <div className="flex-1" />
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="home-messages relative flex-1 overflow-y-auto px-4 pb-4"
        onTouchStart={resetIdle}
        onMouseMove={resetIdle}
        onScroll={handleScroll}
      >
        {isEmpty && (
          <div className="flex h-full flex-col items-center justify-center gap-8">
            <span className="text-xl text-white/30">
              {strings.inputPlaceholder}
            </span>

            {/* Suggestion cards */}
            <div className="home-suggestions grid w-full max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
              {strings.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => handleSuggestion(suggestion)}
                  className="home-suggestion-card rounded-2xl px-4 py-3 text-left text-base text-white/70 transition-all hover:text-white/90"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
        {threads.map((thread: Thread) => (
          <div key={thread.id} className="mb-4">
            {/* User bubble — plain text */}
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

            {/* Assistant bubbles — markdown rendered */}
            {thread.responses
              .filter((msg: ThreadMessage) => msg.role === "assistant")
              .map((msg: ThreadMessage) => (
              <div key={msg.id} className="flex justify-start mb-2">
                <div className="home-bubble home-bubble-assistant max-w-[80%] rounded-2xl px-5 py-3">
                  <div className="home-bubble-text home-bubble-markdown text-white/90">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.text}
                    </ReactMarkdown>
                  </div>
                  {/* File attachments */}
                  {msg.files.length > 0 && (
                    <div>
                      {msg.files.map((file, i) => (
                        <FileAttachment key={`${file.path}-${i}`} file={file} />
                      ))}
                    </div>
                  )}
                  {/* Tool calls indicator */}
                  {msg.toolCalls.length > 0 && (
                    <ToolCallsIndicator toolCalls={msg.toolCalls} />
                  )}
                  <div className="mt-1 text-xs text-white/30 tabular-nums">
                    {formatBubbleTime(msg.timestamp)}
                  </div>
                </div>
              </div>
            ))}

            {/* Pending streaming with smooth animation */}
            {thread.pendingAssistant && thread.pendingAssistant.text && (
              <PendingBubble pending={thread.pendingAssistant} />
            )}

            {/* Thinking indicator — pending with no text yet */}
            {thread.pendingAssistant && !thread.pendingAssistant.text && (
              <ThinkingBubble />
            )}
          </div>
        ))}

        {/* Scroll-to-bottom button */}
        {showScrollBtn && (
          <button
            onClick={scrollToBottom}
            className="home-scroll-bottom"
            aria-label="Scroll to bottom"
          >
            <ChevronDown size={22} />
          </button>
        )}
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
            placeholder={strings.inputPlaceholder}
            rows={1}
            className="home-composer-input flex-1 resize-none bg-transparent px-3 py-3 outline-none"
            autoFocus
          />
          {isStreaming || isPending ? (
            <button
              onClick={handleCancel}
              className="home-stop-button flex shrink-0 items-center justify-center rounded-xl"
              aria-label="Stop"
            >
              <Square size={18} className="text-white" />
            </button>
          ) : (
            <button
              onClick={() => void handleSend()}
              disabled={text.trim().length === 0 || sending}
              className="home-send-button flex shrink-0 items-center justify-center rounded-xl disabled:opacity-30"
              aria-label={strings.send}
            >
              <SendHorizontal size={22} className="text-white" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
