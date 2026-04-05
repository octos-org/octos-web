/**
 * Custom chat thread — renders from the message store, not assistant-ui.
 *
 * Messages are read from `useMessages(sessionId)` and rendered as bubbles:
 * user on right, assistant on left. Supports inline file players,
 * markdown rendering, tool progress, thinking indicators, and message meta.
 */

import {
  useCallback,
  useState,
  useRef,
  useEffect,
  useMemo,
  memo,
} from "react";
import {
  SendHorizontal,
  Square,
  Paperclip,
  X,
  FileIcon,
  Mic,
  Video,
  Camera,
  StopCircle,
  Download,
} from "lucide-react";
import { useSession } from "@/runtime/session-context";
import { useMessages, clearMessages, type Message, type MessageFile } from "@/store/message-store";
import { uploadFiles } from "@/api/chat";
import { sendMessage as bridgeSend } from "@/runtime/sse-bridge";
import * as StreamManager from "@/runtime/stream-manager";
import { MarkdownContent } from "./markdown-renderer";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolProgressIndicator } from "./tool-progress-indicator";
import { API_BASE } from "@/lib/constants";
import { getToken } from "@/api/client";

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const UserBubble = memo(function UserBubble({ message }: { message: Message }) {
  return (
    <div className="flex justify-end px-4 py-3">
      <div className="flex flex-col items-end max-w-[75%]">
        <div
          data-testid="user-message"
          className="rounded-2xl rounded-br-md bg-user-bubble px-5 py-3 text-sm leading-relaxed text-text"
        >
          {message.text}
        </div>
        {message.files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.files.map((f) => (
              <FileAttachment key={f.path} file={f} />
            ))}
          </div>
        )}
        <div className="mt-1.5 px-1 text-[10px] text-muted/50 select-none">
          {formatTimestamp(message.timestamp)}
        </div>
      </div>
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({
  message,
  isLast,
}: {
  message: Message;
  isLast: boolean;
}) {
  return (
    <div className="flex px-4 py-3">
      <div
        data-testid="assistant-message"
        className="max-w-[92%] rounded-2xl rounded-bl-md bg-assistant-bubble px-5 py-4 text-sm leading-relaxed text-text elevation-1 transition-all duration-300 ease-out"
      >
        {message.text ? (
          <MarkdownContent
            text={message.text}
            className="prose prose-invert prose-sm max-w-none"
          />
        ) : message.status === "streaming" ? (
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-accent/60 animate-pulse" />
            <span className="h-2 w-2 rounded-full bg-accent/60 animate-pulse [animation-delay:150ms]" />
            <span className="h-2 w-2 rounded-full bg-accent/60 animate-pulse [animation-delay:300ms]" />
          </span>
        ) : null}

        {/* Inline file attachments */}
        {message.files.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {message.files.map((f) => (
              <FileAttachment key={f.path} file={f} />
            ))}
          </div>
        )}

        {/* Tool calls */}
        {message.toolCalls.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.toolCalls.map((tc) => (
              <span
                key={tc.id}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-mono ${
                  tc.status === "running"
                    ? "bg-accent/20 text-accent animate-pulse"
                    : tc.status === "error"
                      ? "bg-red-500/20 text-red-400"
                      : "bg-surface-container text-muted"
                }`}
              >
                {tc.name}
              </span>
            ))}
          </div>
        )}

        {/* Background task status (only for the last message) */}
        {isLast && <TaskStatusIndicator />}

        {/* Thinking + tool progress (only for the last streaming message) */}
        {isLast && message.status === "streaming" && (
          <>
            <ThinkingIndicator />
            <ToolProgressIndicator />
          </>
        )}

        {/* Message meta */}
        <MessageMetaInline messageId={message.id} isLast={isLast} timestamp={message.timestamp} />
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// File attachment renderer
// ---------------------------------------------------------------------------

/** Fetch a file with auth and return an object URL. */
function useBlobUrl(filePath: string): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    let revoked = false;
    let url: string | undefined;

    // External URLs don't need auth
    if (filePath.startsWith("http")) {
      setBlobUrl(filePath);
      return;
    }

    const token = getToken();
    const apiUrl = `${API_BASE}/api/files?path=${encodeURIComponent(filePath)}`;
    fetch(apiUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.blob();
      })
      .then((blob) => {
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch(() => {
        // Fallback: leave undefined, media element will show broken state
      });

    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [filePath]);

  return blobUrl;
}

function FileAttachment({ file }: { file: MessageFile }) {
  const blobUrl = useBlobUrl(file.path);
  const isAudio = /\.(mp3|wav|ogg|webm|m4a|aac|flac|opus)$/i.test(file.filename);
  const isVideo = /\.(mp4|webm|mov)$/i.test(file.filename);
  const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(file.filename);

  const handleDownload = useCallback(() => {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = file.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [blobUrl, file.filename]);

  if (isAudio) {
    return <AudioAttachment file={file} blobUrl={blobUrl} />;
  }

  if (isVideo) {
    return (
      <div className="rounded-lg border border-border bg-surface-light p-2">
        {blobUrl ? (
          <video controls preload="metadata" className="w-full max-w-sm rounded" src={blobUrl} />
        ) : (
          <div className="flex h-24 items-center justify-center text-xs text-muted">Loading...</div>
        )}
        <div className="mt-1 truncate text-xs text-muted">{file.filename}</div>
      </div>
    );
  }

  if (isImage) {
    return blobUrl ? (
      <a href={blobUrl} target="_blank" rel="noopener noreferrer" className="block">
        <img
          src={blobUrl}
          alt={file.filename}
          className="max-w-full max-h-64 rounded-lg border border-border"
          loading="lazy"
        />
        {file.caption && (
          <div className="mt-1 text-xs text-muted">{file.caption}</div>
        )}
      </a>
    ) : (
      <div className="flex h-24 items-center justify-center rounded-lg border border-border text-xs text-muted">
        Loading...
      </div>
    );
  }

  // Generic download button
  return (
    <button
      onClick={handleDownload}
      disabled={!blobUrl}
      className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container px-3 py-2 text-xs text-link hover:bg-accent/20 hover:text-accent disabled:opacity-50"
    >
      <Download size={14} />
      <span className="truncate max-w-[200px]">{file.filename}</span>
      {file.caption && <span className="text-muted/70">-- {file.caption}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Background task status indicator
// ---------------------------------------------------------------------------

interface TaskInfo {
  id: string;
  tool_name: string;
  status: "spawned" | "running" | "completed" | "failed";
  started_at: string;
  error: string | null;
}

/** Audio attachment — <audio> element only created on first play click. */
function AudioAttachment({ file, blobUrl }: { file: MessageFile; blobUrl?: string }) {
  const [activated, setActivated] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const toggle = useCallback(() => {
    if (!activated) {
      setActivated(true);
      setPlaying(true);
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }, [activated, playing]);

  // Auto-play once <audio> mounts after activation
  useEffect(() => {
    if (activated && audioRef.current && playing) {
      audioRef.current.play().catch(() => setPlaying(false));
    }
  }, [activated, playing]);

  return (
    <div className="rounded-lg border border-border bg-surface-light p-2">
      {blobUrl ? (
        <div className="flex items-center gap-2">
          <button
            onClick={toggle}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:bg-accent-dim"
          >
            {playing ? (
              <span className="text-xs font-bold">❚❚</span>
            ) : (
              <span className="text-xs font-bold ml-0.5">▶</span>
            )}
          </button>
          {activated && (
            <audio
              ref={audioRef}
              src={blobUrl}
              preload="auto"
              onEnded={() => setPlaying(false)}
            />
          )}
          <div className="min-w-0 flex-1 truncate text-xs text-muted">
            {file.filename}
            {file.caption && <span className="ml-1 text-muted/70">-- {file.caption}</span>}
          </div>
        </div>
      ) : (
        <div className="flex h-8 items-center justify-center text-xs text-muted">Loading...</div>
      )}
    </div>
  );
}

function TaskStatusIndicator() {
  const { currentSessionId } = useSession();
  const [tasks, setTasks] = useState<TaskInfo[]>([]);

  // Poll /api/sessions/{id}/tasks every 2s while there are active tasks
  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    // Start polling when SSE done event has bg_tasks
    function handleBgTasks(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId !== currentSessionId) return;
      poll();
    }

    async function poll() {
      if (stopped) return;
      try {
        const token = getToken();
        const resp = await fetch(
          `${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}/tasks`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (resp.ok) {
          const data = (await resp.json()) as TaskInfo[];
          if (!stopped) setTasks(data);
          // Keep polling if any task is still active
          const hasActive = data.some(
            (t) => t.status === "running" || t.status === "spawned",
          );
          if (hasActive && !stopped) {
            pollTimer = setTimeout(poll, 2000);
          }
        }
      } catch {
        // poll failed, retry
        if (!stopped) pollTimer = setTimeout(poll, 3000);
      }
    }

    // Also listen for SSE task_status events (if stream is still open)
    function handleTaskStatus(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId !== currentSessionId) return;
      poll(); // refresh from API on any status change
    }

    window.addEventListener("crew:bg_tasks", handleBgTasks);
    window.addEventListener("crew:task_status", handleTaskStatus);
    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener("crew:bg_tasks", handleBgTasks);
      window.removeEventListener("crew:task_status", handleTaskStatus);
    };
  }, [currentSessionId]);

  if (tasks.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1">
      {tasks.map((task) => (
        <TaskStatusPill key={task.id} task={task} />
      ))}
    </div>
  );
}

function TaskStatusPill({ task }: { task: TaskInfo }) {
  const [, setTick] = useState(0);
  const isActive = task.status === "running" || task.status === "spawned";

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const elapsed = Math.round(
    (Date.now() - new Date(task.started_at).getTime()) / 1000,
  );

  return (
    <div className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-mono bg-surface-container">
      {isActive ? (
        <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
      ) : task.status === "completed" ? (
        <span className="text-green-400 text-xs">&#10003;</span>
      ) : (
        <span className="text-red-400 text-xs">&#10007;</span>
      )}
      <span className="text-muted">{task.tool_name}</span>
      {isActive && <span className="text-muted/60">{elapsed}s</span>}
      {task.status === "failed" && task.error && (
        <span className="text-red-400 truncate max-w-[200px]">{task.error}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline message meta (replaces the old assistant-ui based MessageMeta)
// ---------------------------------------------------------------------------

interface MetaData {
  model: string;
  tokens_in: number;
  tokens_out: number;
  duration_s: number;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function MessageMetaInline({
  messageId,
  isLast,
  timestamp,
}: {
  messageId: string;
  isLast: boolean;
  timestamp: number;
}) {
  const { currentSessionId } = useSession();
  const [meta, setMeta] = useState<MetaData | null>(null);

  useEffect(() => {
    if (!isLast) return;
    function handleMeta(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail.sessionId && detail.sessionId !== currentSessionId) return;
      // Accept meta if it targets this message or is the generic last-message meta
      if (detail.messageId && detail.messageId !== messageId) return;
      if (detail.model || detail.tokens_in || detail.tokens_out) {
        setMeta({
          model: detail.model || "",
          tokens_in: detail.tokens_in || 0,
          tokens_out: detail.tokens_out || 0,
          duration_s: detail.duration_s || 0,
        });
      }
    }
    window.addEventListener("crew:message_meta", handleMeta);
    return () => window.removeEventListener("crew:message_meta", handleMeta);
  }, [isLast, currentSessionId, messageId]);

  const parts: string[] = [];
  if (meta) {
    if (meta.model) parts.push(meta.model);
    if (meta.tokens_in) parts.push(`${formatTokens(meta.tokens_in)} in`);
    if (meta.tokens_out) parts.push(`${formatTokens(meta.tokens_out)} out`);
    if (meta.duration_s) parts.push(`${meta.duration_s}s`);
  }
  parts.push(formatTimestamp(timestamp));

  if (meta && (meta.model || meta.tokens_in || meta.tokens_out)) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted/60 select-none">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent/40" />
        {parts.join(" · ")}
      </div>
    );
  }

  return (
    <div className="mt-1.5 text-[10px] text-muted/60 select-none">
      {formatTimestamp(timestamp)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const COMMANDS = [
  // Session management
  { cmd: "/new", desc: "Start a new chat session (or /new <topic> to name it)" },
  { cmd: "/s", desc: "Switch session by topic (/s coding, /s research)" },
  { cmd: "/sessions", desc: "List all active sessions" },
  { cmd: "/back", desc: "Switch back to the previous session" },
  { cmd: "/delete", desc: "Delete a session (/delete <name> or /d <name>)" },
  { cmd: "/clear", desc: "Clear current session and start fresh" },
  // Personality
  { cmd: "/soul", desc: "View or set custom personality (/soul, /soul show, /soul reset, /soul <text>)" },
  // Agent configuration
  { cmd: "/queue", desc: "Set queue mode (collect|steer|interrupt|speculative)" },
  { cmd: "/adaptive", desc: "Set routing mode (off|hedge|lane)" },
  { cmd: "/status", desc: "Configure status indicators (greeting, provider, metrics)" },
  { cmd: "/reset", desc: "Reset queue, adaptive, and history" },
  // Help
  { cmd: "/help", desc: "Show available commands" },
];

// ---------------------------------------------------------------------------
// AudioBuffer to WAV helper
// ---------------------------------------------------------------------------

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const length = buffer.length * numChannels;
  const samples = new Int16Array(length);
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      samples[i * numChannels + ch] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const buf = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  new Int16Array(buf, headerSize).set(samples);
  return new Blob([buf], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// File attachment types for the composer
// ---------------------------------------------------------------------------

interface PendingFile {
  file: File;
  preview?: string;
  serverPath?: string;
}

// ---------------------------------------------------------------------------
// Main ChatThread component
// ---------------------------------------------------------------------------

export function ChatThread() {
  const { currentSessionId } = useSession();
  const messages = useMessages(currentSessionId);
  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-full flex-col min-h-0 bg-surface-dark">
      {hasMessages ? (
        <MessageList messages={messages} sessionId={currentSessionId} />
      ) : (
        <div className="flex flex-1 min-h-0 flex-col items-center justify-center px-6">
          <h1 className="mb-3 text-3xl font-light tracking-tight text-text-strong">
            What can I help with?
          </h1>
          <p className="mb-10 text-sm text-muted">
            Ask anything, attach files, or record a voice message.
          </p>
        </div>
      )}
      <div className="shrink-0">
        <Composer />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message list with auto-scroll
// ---------------------------------------------------------------------------

function MessageList({
  messages,
}: {
  messages: Message[];
  sessionId: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Detect whether user has scrolled up (passive for performance)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 80;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll when messages change (new message or text update)
  useEffect(() => {
    if (stickToBottomRef.current && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      ref={viewportRef}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto max-w-4xl py-6">
        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          if (msg.role === "user") {
            return <UserBubble key={msg.id} message={msg} />;
          }
          if (msg.role === "assistant") {
            return (
              <AssistantBubble key={msg.id} message={msg} isLast={isLast} />
            );
          }
          // system messages — render as a subtle divider
          return (
            <div key={msg.id} className="px-4 py-2 text-center text-xs text-muted/60">
              {msg.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer() {
  const { createSession, removeSession, currentSessionId, refreshSessions, markSessionActive } =
    useSession();
  const messages = useMessages(currentSessionId);
  const isRunning = useMemo(
    () => messages.some((m) => m.status === "streaming"),
    [messages],
  );

  const [text, setText] = useState("");
  const [cmdFeedback, setCmdFeedback] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  // Recording state
  const [recording, setRecording] = useState<"voice" | "video" | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);

  // Recording timer
  useEffect(() => {
    if (recording) {
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setRecordingTime(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recording]);

  const startRecording = useCallback(async (mode: "voice" | "video") => {
    try {
      const constraints: MediaStreamConstraints =
        mode === "voice"
          ? { audio: true }
          : { audio: true, video: { facingMode: "user", width: 640, height: 480 } };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      if (mode === "video" && videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
        videoPreviewRef.current.play();
      }
      const recordMime =
        mode === "voice"
          ? MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : MediaRecorder.isTypeSupported("audio/mp4")
              ? "audio/mp4"
              : "audio/webm"
          : MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
            ? "video/webm;codecs=vp9,opus"
            : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType: recordMime });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const rawBlob = new Blob(chunksRef.current, { type: recordMime });
        let blob: Blob;
        let ext: string;
        let fileType: string;
        if (mode === "voice") {
          const audioCtx = new AudioContext();
          try {
            const arrayBuf = await rawBlob.arrayBuffer();
            const decoded = await audioCtx.decodeAudioData(arrayBuf);
            blob = audioBufferToWav(decoded);
            ext = "wav";
            fileType = "audio/wav";
          } catch (e) {
            console.warn("WAV conversion failed, sending raw:", e);
            blob = rawBlob;
            ext = recordMime.includes("mp4") ? "m4a" : "ogg";
            fileType = blob.type;
          } finally {
            audioCtx.close();
          }
        } else {
          blob = rawBlob;
          ext = "webm";
          fileType = blob.type;
        }
        const filename = `${mode}-${Date.now()}.${ext}`;
        const file = new File([blob], filename, { type: fileType });
        const pf: PendingFile = { file };
        if (mode === "video") pf.preview = URL.createObjectURL(blob);
        setPendingFiles((prev) => [...prev, pf]);
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null;
      };
      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setRecording(mode);
    } catch (e) {
      setCmdFeedback(
        `Recording failed: ${e instanceof Error ? e.message : "permission denied"}`,
      );
      setTimeout(() => setCmdFeedback(null), 4000);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    setRecording(null);
  }, []);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Camera preview
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);

  const openCamera = useCallback(async () => {
    try {
      // Stop any previous camera stream to prevent leaks on rapid re-open
      if (cameraStream) {
        cameraStream.getTracks().forEach((t) => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 1280, height: 720 },
      });
      setCameraStream(stream);
    } catch (e) {
      setCmdFeedback(`Camera failed: ${e instanceof Error ? e.message : "permission denied"}`);
      setTimeout(() => setCmdFeedback(null), 4000);
    }
  }, []);

  useEffect(() => {
    if (cameraStream && cameraPreviewRef.current) {
      cameraPreviewRef.current.srcObject = cameraStream;
      cameraPreviewRef.current.play();
    }
  }, [cameraStream]);

  const capturePhoto = useCallback(() => {
    if (!cameraPreviewRef.current || !cameraStream) return;
    const video = cameraPreviewRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    cameraStream.getTracks().forEach((t) => t.stop());
    setCameraStream(null);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        setPendingFiles((prev) => [...prev, { file, preview: URL.createObjectURL(blob) }]);
      },
      "image/jpeg",
      0.9,
    );
  }, [cameraStream]);

  const cancelCamera = useCallback(() => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      setCameraStream(null);
    }
  }, [cameraStream]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newFiles: PendingFile[] = Array.from(files).map((file) => {
      const pf: PendingFile = { file };
      if (file.type.startsWith("image/")) pf.preview = URL.createObjectURL(file);
      return pf;
    });
    setPendingFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const removed = prev[index];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // Revoke any remaining blob URLs on unmount to prevent leaks
  useEffect(() => {
    return () => {
      setPendingFiles((prev) => {
        for (const pf of prev) {
          if (pf.preview) URL.revokeObjectURL(pf.preview);
        }
        return prev;
      });
    };
  }, []);

  const sendingRef = useRef(false);
  const isEmpty = text.trim().length === 0;

  const handleSend = useCallback(async () => {
    if (isEmpty && pendingFiles.length === 0) return;
    const input = text.trim();

    // Handle slash commands
    if (input === "/new") {
      setText("");
      createSession();
      return;
    }
    if (input === "/clear") {
      setText("");
      // Clear messages locally and create fresh session
      clearMessages(currentSessionId);
      createSession();
      return;
    }
    if (input === "/delete") {
      setText("");
      removeSession(currentSessionId);
      return;
    }
    if (input === "/help" || input === "/") {
      setText("");
      setCmdFeedback(
        COMMANDS.map((c) => `${c.cmd} — ${c.desc}`).join("\n"),
      );
      setTimeout(() => setCmdFeedback(null), 10000);
      return;
    }

    sendingRef.current = true;

    let mediaPaths: string[] = [];

    // Upload files first
    if (pendingFiles.length > 0) {
      setUploading(true);
      try {
        mediaPaths = await uploadFiles(pendingFiles.map((pf) => pf.file));
      } catch (e) {
        setCmdFeedback(`Upload failed: ${e instanceof Error ? e.message : "unknown error"}`);
        setTimeout(() => setCmdFeedback(null), 4000);
        setUploading(false);
        sendingRef.current = false;
        return;
      }
      for (const pf of pendingFiles) {
        if (pf.preview) URL.revokeObjectURL(pf.preview);
      }
      setPendingFiles([]);
      setUploading(false);
    }

    const messageText =
      input ||
      `[Attached: ${mediaPaths.map((p) => p.split("/").pop() || "file").join(", ")}]`;

    // Send via SSE bridge (StreamManager queues if a stream is already active)
    bridgeSend({
      sessionId: currentSessionId,
      text: messageText,
      media: mediaPaths,
      onSessionActive: (firstMsg) => markSessionActive(firstMsg),
      onComplete: () => {
        sendingRef.current = false;
        refreshSessions();
      },
    });

    setText("");
  }, [
    text,
    isEmpty,
    pendingFiles,
    isRunning,
    currentSessionId,
    createSession,
    removeSession,
    refreshSessions,
    markSessionActive,
  ]);

  const handleCancel = useCallback(() => {
    StreamManager.destroyStream(currentSessionId);
  }, [currentSessionId]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't send during IME composition (Chinese/Japanese/Korean input)
      if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [text]);

  const showCmdHints = text.startsWith("/") && text.length < 10;
  const matchingCmds = showCmdHints ? COMMANDS.filter((c) => c.cmd.startsWith(text)) : [];

  return (
    <div
      className="bg-surface-dark px-4 pb-6 pt-2"
      onPaste={handlePaste}
    >
      <div
        className="mx-auto max-w-3xl"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
        }}
      >
        {cmdFeedback && (
          <div
            data-testid="cmd-feedback"
            className="mb-3 rounded-xl bg-accent-container px-4 py-2.5 text-xs text-accent"
          >
            {cmdFeedback}
          </div>
        )}
        {matchingCmds.length > 0 && (
          <div data-testid="cmd-hints" className="mb-3 flex flex-wrap gap-1.5">
            {matchingCmds.map((c) => (
              <button
                key={c.cmd}
                onClick={() => setText(c.cmd)}
                className="rounded-lg bg-surface-container px-3 py-1.5 text-xs text-text hover:bg-accent-container hover:text-accent"
              >
                <span className="font-mono">{c.cmd}</span>{" "}
                <span className="text-muted">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        {/* Camera preview */}
        {cameraStream && (
          <div className="mb-3 overflow-hidden rounded-2xl bg-surface-container elevation-2">
            <video ref={cameraPreviewRef} muted playsInline className="h-48 w-full object-cover" />
            <div className="flex items-center justify-between px-4 py-2.5 bg-surface-elevated">
              <span className="text-xs text-muted">Camera preview</span>
              <div className="flex gap-2">
                <button
                  onClick={cancelCamera}
                  className="rounded-lg px-3 py-1.5 text-xs text-muted hover:text-text hover:bg-surface-container"
                >
                  Cancel
                </button>
                <button
                  onClick={capturePhoto}
                  className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs text-white hover:bg-green-700"
                >
                  <Camera size={12} /> Capture
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Recording indicator */}
        {recording && (
          <div className="mb-3 flex items-center gap-3 rounded-2xl bg-red-900/20 px-4 py-3">
            <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            <span className="text-sm text-red-400">
              {recording === "voice" ? "Recording audio" : "Recording video"} --{" "}
              {formatTime(recordingTime)}
            </span>
            <button
              onClick={stopRecording}
              className="ml-auto flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700"
            >
              <StopCircle size={12} /> Stop
            </button>
          </div>
        )}
        {recording === "video" && (
          <div className="mb-2 overflow-hidden rounded-lg border border-border">
            <video ref={videoPreviewRef} muted className="h-48 w-full object-cover" />
          </div>
        )}
        {/* File previews */}
        {pendingFiles.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            {pendingFiles.map((pf, i) => (
              <div key={i} className="relative group rounded-xl bg-surface-container p-1.5 elevation-1">
                {pf.preview && pf.file.type.startsWith("image/") ? (
                  <img src={pf.preview} alt={pf.file.name} className="h-16 w-16 rounded-lg object-cover" />
                ) : pf.preview && pf.file.type.startsWith("video/") ? (
                  <video src={pf.preview} className="h-16 w-16 rounded-lg object-cover" />
                ) : pf.file.type.startsWith("audio/") ? (
                  <div className="flex h-16 w-16 flex-col items-center justify-center rounded-lg bg-surface text-xs text-muted">
                    <Mic size={20} />
                    <span className="mt-1 text-[10px]">{(pf.file.size / 1024).toFixed(0)}KB</span>
                  </div>
                ) : (
                  <div className="flex h-16 w-16 flex-col items-center justify-center rounded-lg bg-surface text-xs text-muted">
                    <FileIcon size={20} />
                    <span className="mt-1 max-w-[56px] truncate">{pf.file.name.split(".").pop()}</span>
                  </div>
                )}
                <button
                  onClick={() => removeFile(i)}
                  className="absolute -right-1 -top-1 hidden rounded-full bg-red-600 p-0.5 text-white group-hover:block"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-col rounded-2xl bg-surface-container p-2 elevation-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {/* Top row: text input + send */}
          <div className="flex items-end gap-1.5">
            <textarea
              ref={textareaRef}
              data-testid="chat-input"
              placeholder={
                pendingFiles.length > 0
                  ? `${pendingFiles.length} file(s) attached -- add a message...`
                  : "Send a message..."
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              rows={1}
              className="flex-1 resize-none bg-transparent px-3 py-2.5 text-sm text-text placeholder-muted/60 outline-none"
              autoFocus
            />
            <button
              data-testid="send-button"
              aria-label="Send message"
              onClick={handleSend}
              disabled={isEmpty && pendingFiles.length === 0}
              className={`flex shrink-0 items-center justify-center rounded-xl disabled:opacity-30 ${
                pendingFiles.length > 0
                  ? "h-10 gap-1.5 px-4 bg-green-600 text-white hover:bg-green-700"
                  : "h-10 w-10 bg-accent text-white hover:bg-accent-dim"
              }`}
            >
              {uploading ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              ) : pendingFiles.length > 0 ? (
                <>
                  <SendHorizontal size={16} />
                  <span className="text-sm font-medium">Send</span>
                </>
              ) : (
                <SendHorizontal size={18} />
              )}
            </button>
            {isRunning && (
              <button
                data-testid="cancel-button"
                aria-label="Cancel"
                onClick={handleCancel}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-600 text-white hover:bg-red-700"
              >
                <Square size={16} />
              </button>
            )}
          </div>
          {/* Bottom row: media buttons */}
          <div className="flex items-center gap-0.5 px-1 pt-1">
            <button
              data-testid="attach-button"
              aria-label="Attach file"
              onClick={() => fileInputRef.current?.click()}
              disabled={recording !== null}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-elevated hover:text-accent disabled:opacity-30"
              title="Attach files"
            >
              <Paperclip size={16} />
            </button>
            <button
              data-testid="voice-button"
              onClick={() => (recording === "voice" ? stopRecording() : startRecording("voice"))}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                recording === "voice"
                  ? "bg-red-600 text-white animate-pulse"
                  : "text-muted hover:bg-surface-elevated hover:text-accent"
              } ${recording === "video" ? "opacity-30 pointer-events-none" : ""}`}
              title={recording === "voice" ? "Stop recording" : "Record voice"}
            >
              {recording === "voice" ? <StopCircle size={16} /> : <Mic size={16} />}
            </button>
            <button
              data-testid="video-button"
              onClick={() => (recording === "video" ? stopRecording() : startRecording("video"))}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                recording === "video"
                  ? "bg-red-600 text-white animate-pulse"
                  : "text-muted hover:bg-surface-elevated hover:text-accent"
              } ${recording === "voice" ? "opacity-30 pointer-events-none" : ""}`}
              title={recording === "video" ? "Stop recording" : "Record video"}
            >
              {recording === "video" ? <StopCircle size={16} /> : <Video size={16} />}
            </button>
            <button
              data-testid="camera-button"
              onClick={cameraStream ? capturePhoto : openCamera}
              disabled={recording !== null}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                cameraStream
                  ? "bg-green-600 text-white hover:bg-green-700"
                  : "text-muted hover:bg-surface-elevated hover:text-accent"
              } disabled:opacity-30`}
              title={cameraStream ? "Take photo" : "Open camera"}
            >
              <Camera size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
