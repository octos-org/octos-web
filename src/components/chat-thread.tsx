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
import {
  useMessages,
  clearMessages,
  type Message,
  type MessageFile,
  type MessageMeta,
} from "@/store/message-store";
import { uploadFiles } from "@/api/chat";
import { sendMessage as bridgeSend } from "@/runtime/sse-bridge";
import * as StreamManager from "@/runtime/stream-manager";
import { MarkdownContent } from "./markdown-renderer";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolProgressIndicator } from "./tool-progress-indicator";
import { buildFileUrl } from "@/api/files";
import { displayFilenameFromPath } from "@/lib/utils";
import { getToken, request } from "@/api/client";

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function userBubbleVisibleText(message: Message): string {
  if (message.files.length === 0) return message.text;
  const trimmed = message.text.trim();
  if (/^\[Attached: .*\]$/u.test(trimmed)) return "";
  if (trimmed === "[User sent an image]") return "";
  return message.text;
}

function visibleAttachmentCaption(caption?: string): string {
  if (!caption) return "";
  if (/^\s*[✓✗]\s+\S+.*\b(completed|failed|error)\b/iu.test(caption.trim())) {
    return "";
  }
  return caption;
}

const UserBubble = memo(function UserBubble({ message }: { message: Message }) {
  const visibleText = userBubbleVisibleText(message);
  return (
    <div className="flex justify-end px-4 py-3">
      <div className="flex max-w-[74%] flex-col items-end">
        {visibleText && (
          <div
            data-testid="user-message"
            className="message-card message-card-user rounded-[14px] rounded-br-[4px] px-4 py-2.5 text-sm leading-relaxed text-text"
          >
            {visibleText}
          </div>
        )}
        {message.files.length > 0 && (
          <div className={`${visibleText ? "mt-2" : ""} flex flex-wrap gap-2`}>
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
        className="message-card message-card-assistant animate-shell-rise max-w-[88%] rounded-[14px] rounded-bl-[4px] px-4 py-3 text-sm leading-relaxed text-text"
      >
        {message.text ? (
          <MarkdownContent
            text={message.text}
            className="prose prose-invert prose-sm max-w-none min-w-0 break-words"
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
                className={`glass-pill inline-flex items-center gap-1 rounded-[10px] px-2.5 py-1 text-[10px] font-mono ${
                  tc.status === "running"
                    ? "border-accent/20 bg-accent/14 text-accent animate-pulse"
                    : tc.status === "error"
                      ? "border-red-500/20 bg-red-500/12 text-red-400"
                      : "text-muted"
                }`}
              >
                {tc.name}
              </span>
            ))}
          </div>
        )}

        {/* Thinking + tool progress (only for the last streaming message) */}
        {isLast && message.status === "streaming" && (
          <>
            <ThinkingIndicator />
            <ToolProgressIndicator />
          </>
        )}

        {/* Message meta */}
        <MessageMetaInline message={message} />
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
    const apiUrl = buildFileUrl(filePath);
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
  const visibleCaption = visibleAttachmentCaption(file.caption);

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
      <div className="message-attachment-card rounded-[10px] p-2">
        {blobUrl ? (
          <video controls preload="metadata" className="w-full max-w-sm rounded-[8px]" src={blobUrl} />
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
          className="message-attachment-card max-h-64 max-w-full rounded-[10px]"
          loading="lazy"
        />
        {visibleCaption && (
          <div className="mt-1 text-xs text-muted">{visibleCaption}</div>
        )}
      </a>
    ) : (
      <div className="message-attachment-card flex h-32 w-28 items-center justify-center rounded-[10px] bg-[linear-gradient(135deg,rgba(255,255,255,0.16),rgba(255,255,255,0.06))]">
        <div className="flex w-full flex-col gap-2 px-3">
          <div className="h-16 w-full animate-pulse rounded-[8px] bg-white/10" />
          <div className="h-2.5 w-2/3 animate-pulse rounded-full bg-white/10" />
        </div>
      </div>
    );
  }

  // Generic download button
  return (
    <button
      onClick={handleDownload}
      disabled={!blobUrl}
      className="glass-pill inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[10px] px-3 py-2 text-xs text-link hover:text-accent disabled:opacity-50"
    >
      <Download size={14} className="shrink-0" />
      <span className="truncate">{file.filename}</span>
    </button>
  );
}

/** Audio attachment — <audio> element only created on first play click. */
function AudioAttachment({ file, blobUrl }: { file: MessageFile; blobUrl?: string }) {
  const [activated, setActivated] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const visibleCaption = visibleAttachmentCaption(file.caption);

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
    <div className="message-attachment-card rounded-[10px] p-2">
      {blobUrl ? (
        <div className="flex items-center gap-2">
          <button
            onClick={toggle}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent text-white hover:bg-accent-dim"
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
            {visibleCaption && <span className="ml-1 text-muted/70">-- {visibleCaption}</span>}
          </div>
        </div>
      ) : (
        <div className="flex h-8 items-center justify-center text-xs text-muted">Loading...</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline message meta (replaces the old assistant-ui based MessageMeta)
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function MessageMetaInline({
  message,
}: {
  message: Message;
}) {
  const meta: MessageMeta | undefined = message.meta;

  const parts: string[] = [];
  if (meta) {
    if (meta.model) parts.push(meta.model);
    if (meta.tokens_in) parts.push(`${formatTokens(meta.tokens_in)} in`);
    if (meta.tokens_out) parts.push(`${formatTokens(meta.tokens_out)} out`);
    if (meta.duration_s) parts.push(`${meta.duration_s}s`);
  }
  parts.push(formatTimestamp(message.timestamp));

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
      {formatTimestamp(message.timestamp)}
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

interface MyProfileResponse {
  profile?: {
    config?: {
      gateway?: {
        system_prompt?: string | null;
      };
    };
  };
}

async function getMyProfileSystemPrompt(): Promise<string | null> {
  const response = await request<MyProfileResponse>("/api/my/profile");
  return response.profile?.config?.gateway?.system_prompt ?? null;
}

async function updateMyProfileSystemPrompt(systemPrompt: string | null): Promise<void> {
  await request("/api/my/profile", {
    method: "PUT",
    body: JSON.stringify({
      config: {
        gateway: {
          system_prompt: systemPrompt,
        },
      },
    }),
  });
}

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
  source?: "recording" | "upload";
}

// ---------------------------------------------------------------------------
// Main ChatThread component
// ---------------------------------------------------------------------------

interface ChatThreadProps {
  hideFileOnlyAssistantMessages?: boolean;
}

function isFileOnlyAssistantMessage(message: Message): boolean {
  return (
    message.role === "assistant" &&
    !message.text.trim() &&
    message.files.length > 0 &&
    message.toolCalls.length === 0
  );
}

export function ChatThread({
  hideFileOnlyAssistantMessages = false,
}: ChatThreadProps = {}) {
  const { currentSessionId } = useSession();
  const messages = useMessages(currentSessionId);
  const visibleMessages = useMemo(
    () =>
      hideFileOnlyAssistantMessages
        ? messages.filter((message) => !isFileOnlyAssistantMessage(message))
        : messages,
    [hideFileOnlyAssistantMessages, messages],
  );
  const hasMessages = visibleMessages.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      {hasMessages ? (
        <MessageList messages={visibleMessages} sessionId={currentSessionId} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          <div className="glass-section animate-shell-rise max-w-xl rounded-[12px] px-7 py-9 text-center">
            <div className="shell-kicker">Conversation Studio</div>
            <h1 className="mb-3 mt-3 text-3xl font-light tracking-tight text-text-strong">
              What can I help with?
            </h1>
            <p className="text-sm text-muted">
              Ask anything, attach files, or record a voice message.
            </p>
          </div>
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
      data-testid="chat-thread"
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
  const {
    sessions,
    createSession,
    removeSession,
    currentSessionId,
    historyTopic,
    refreshSessions,
    markSessionActive,
    switchSession,
    goBack,
    beforeSend,
  } =
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
        const pf: PendingFile = { file, source: "recording" };
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
      const pf: PendingFile = { file, source: "upload" };
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

  const formatSessionList = useCallback(() => {
    const visible = sessions.filter((session) => (session.message_count ?? 0) > 0 || session._local);
    if (visible.length === 0) return "No sessions found.";
    return visible
      .map((session, index) => {
        const label = session.title?.trim() || session.id;
        const marker = session.id === currentSessionId ? "*" : " ";
        return `${marker} ${index + 1}. ${label}`;
      })
      .join("\n");
  }, [currentSessionId, sessions]);

  const findSessionMatches = useCallback(
    (query: string) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      return sessions.filter((session) => {
        const title = session.title?.toLowerCase() || "";
        const id = session.id.toLowerCase();
        return title.includes(needle) || id.includes(needle);
      });
    },
    [sessions],
  );

  const handleSend = useCallback(async () => {
    if (isEmpty && pendingFiles.length === 0) return;
    const input = text.trim();

    let mediaPaths: string[] = [];
    let audioUploadMode: "recording" | "upload" | undefined;

    const slashAttachedText = pendingFiles.length
      ? `[Attached: ${pendingFiles.map((pf) => pf.file.name).join(", ")}]`
      : "";
    const slashRequestText =
      input ||
      (pendingFiles.length > 0 ? slashAttachedText : "");

    const slashPayload = {
      sessionId: currentSessionId,
      text: slashRequestText,
      requestText: slashRequestText,
      media: mediaPaths,
      audioUploadMode,
    };

    try {
      const intercepted = beforeSend
        ? await beforeSend(slashPayload)
        : undefined;
      if (intercepted?.handled) {
        sendingRef.current = false;
        setText("");
        refreshSessions();
        return;
      }
    } catch (e) {
      setCmdFeedback(
        `Send failed: ${e instanceof Error ? e.message : "unknown error"}`,
      );
      setTimeout(() => setCmdFeedback(null), 4000);
      sendingRef.current = false;
      return;
    }

    // Handle slash commands
    if (input === "/new" || input.startsWith("/new ")) {
      setText("");
      const title = input === "/new" ? undefined : input.slice("/new".length).trim();
      createSession(title);
      return;
    }
    if (input === "/sessions") {
      setText("");
      setCmdFeedback(formatSessionList());
      setTimeout(() => setCmdFeedback(null), 10000);
      return;
    }
    if (input === "/back" || input === "/b") {
      setText("");
      const switched = await goBack();
      setCmdFeedback(switched ? "Switched to previous session." : "No previous session.");
      setTimeout(() => setCmdFeedback(null), 4000);
      return;
    }
    if (input === "/s" || input === "/switch") {
      setText("");
      setCmdFeedback("Usage: /s <session title or id fragment>");
      setTimeout(() => setCmdFeedback(null), 4000);
      return;
    }
    if (input.startsWith("/s ")) {
      const query = input.slice(3).trim();
      const matches = findSessionMatches(query);
      setText("");
      if (matches.length === 0) {
        setCmdFeedback(`No session matches "${query}".`);
      } else if (matches.length > 1) {
        setCmdFeedback(
          `Multiple matches:\n${matches
            .map((session) => `- ${session.title?.trim() || session.id}`)
            .join("\n")}`,
        );
      } else {
        await switchSession(matches[0].id);
        setCmdFeedback(`Switched to ${matches[0].title?.trim() || matches[0].id}.`);
      }
      setTimeout(() => setCmdFeedback(null), 6000);
      return;
    }
    if (input === "/clear") {
      setText("");
      // Clear messages locally and create fresh session
      clearMessages(currentSessionId);
      createSession();
      return;
    }
    if (input === "/delete" || input === "/d") {
      setText("");
      await removeSession(currentSessionId);
      return;
    }
    if (input.startsWith("/delete ") || input.startsWith("/d ")) {
      const query =
        input.startsWith("/delete ")
          ? input.slice("/delete ".length).trim()
          : input.slice("/d ".length).trim();
      const matches = findSessionMatches(query);
      setText("");
      if (matches.length === 0) {
        setCmdFeedback(`No session matches "${query}".`);
      } else if (matches.length > 1) {
        setCmdFeedback(
          `Multiple matches:\n${matches
            .map((session) => `- ${session.title?.trim() || session.id}`)
            .join("\n")}`,
        );
      } else {
        await removeSession(matches[0].id);
        setCmdFeedback(`Deleted ${matches[0].title?.trim() || matches[0].id}.`);
      }
      setTimeout(() => setCmdFeedback(null), 6000);
      return;
    }
    if (input === "/soul" || input === "/soul show") {
      setText("");
      try {
        const systemPrompt = await getMyProfileSystemPrompt();
        setCmdFeedback(
          systemPrompt?.trim()
            ? `Current soul:\n${systemPrompt}`
            : "Current soul: (none)",
        );
      } catch (e) {
        setCmdFeedback(
          `Failed to read soul: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
      setTimeout(() => setCmdFeedback(null), 12000);
      return;
    }
    if (input === "/soul reset") {
      setText("");
      try {
        await updateMyProfileSystemPrompt(null);
        setCmdFeedback("Soul reset.");
      } catch (e) {
        setCmdFeedback(
          `Failed to reset soul: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
      setTimeout(() => setCmdFeedback(null), 6000);
      return;
    }
    if (input.startsWith("/soul ")) {
      const soulText = input.slice("/soul ".length).trim();
      setText("");
      if (!soulText) {
        setCmdFeedback("Usage: /soul <text> | /soul show | /soul reset");
        setTimeout(() => setCmdFeedback(null), 4000);
        return;
      }
      try {
        await updateMyProfileSystemPrompt(soulText);
        setCmdFeedback("Soul updated.");
      } catch (e) {
        setCmdFeedback(
          `Failed to update soul: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
      setTimeout(() => setCmdFeedback(null), 6000);
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

    // Upload files first
    if (pendingFiles.length > 0) {
      const audioFiles = pendingFiles.filter((pf) => pf.file.type.startsWith("audio/"));
      if (audioFiles.length > 0) {
        audioUploadMode = audioFiles.every((pf) => pf.source === "recording")
          ? "recording"
          : "upload";
      }
      setUploading(true);
      try {
        mediaPaths = await uploadFiles(
          pendingFiles.map((pf) => pf.file),
          audioUploadMode,
        );
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

    const attachedText = `[Attached: ${mediaPaths.map((p) => displayFilenameFromPath(p)).join(", ")}]`;
    const messageText =
      input ||
      (audioUploadMode === "recording" ? "[Voice message]" : attachedText);
    const requestText =
      !input && audioUploadMode ? "" : messageText;

    let finalPayload = {
      sessionId: currentSessionId,
      text: messageText,
      requestText,
      media: mediaPaths,
      audioUploadMode,
    };

    try {
      const intercepted = beforeSend
        ? await beforeSend(finalPayload)
        : undefined;
      if (intercepted?.handled) {
        sendingRef.current = false;
        setText("");
        refreshSessions();
        return;
      }
      finalPayload = {
        ...finalPayload,
        ...intercepted,
      };
    } catch (e) {
      setCmdFeedback(
        `Send failed: ${e instanceof Error ? e.message : "unknown error"}`,
      );
      setTimeout(() => setCmdFeedback(null), 4000);
      sendingRef.current = false;
      return;
    }

    // Send via SSE bridge (StreamManager queues if a stream is already active)
    bridgeSend({
      ...finalPayload,
      historyTopic,
      onSessionActive: (firstMsg) => markSessionActive(firstMsg),
      onComplete: () => {
        sendingRef.current = false;
        refreshSessions();
      },
    });

    setText("");
  }, [
    sessions,
    text,
    isEmpty,
    pendingFiles,
    currentSessionId,
    historyTopic,
    createSession,
    switchSession,
    goBack,
    removeSession,
    refreshSessions,
    markSessionActive,
    beforeSend,
    formatSessionList,
    findSessionMatches,
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
      className="px-4 pb-6 pt-2"
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
            className="glass-pill animate-shell-rise mb-3 whitespace-pre-wrap rounded-[10px] px-3.5 py-2 text-xs text-accent"
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
                className="glass-pill rounded-[10px] px-3 py-1.5 text-xs text-text hover:text-accent"
              >
                <span className="font-mono">{c.cmd}</span>{" "}
                <span className="text-muted">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        {/* Camera preview */}
        {cameraStream && (
          <div className="glass-section animate-shell-rise mb-3 overflow-hidden rounded-[12px]">
            <video ref={cameraPreviewRef} muted playsInline className="h-48 w-full object-cover" />
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-xs text-muted">Camera preview</span>
              <div className="flex gap-2">
                <button
                  onClick={cancelCamera}
                  className="glass-icon-button rounded-[10px] px-3 py-1.5 text-xs hover:text-text"
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
          <div className="glass-pill animate-shell-rise mb-3 flex items-center gap-3 rounded-[10px] border-red-500/20 bg-red-900/14 px-4 py-3">
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
          <div className="message-attachment-card mb-2 overflow-hidden rounded-[10px]">
            <video ref={videoPreviewRef} muted className="h-48 w-full object-cover" />
          </div>
        )}
        {/* File previews */}
        {pendingFiles.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            {pendingFiles.map((pf, i) => (
              <div key={i} className="message-attachment-card animate-shell-rise relative group rounded-[10px] p-1.5">
                {pf.preview && pf.file.type.startsWith("image/") ? (
                  <img src={pf.preview} alt={pf.file.name} className="h-16 w-16 rounded-[8px] object-cover" />
                ) : pf.preview && pf.file.type.startsWith("video/") ? (
                  <video src={pf.preview} className="h-16 w-16 rounded-[8px] object-cover" />
                ) : pf.file.type.startsWith("audio/") ? (
                  <div className="flex h-16 w-16 flex-col items-center justify-center rounded-[8px] bg-surface text-xs text-muted">
                    <Mic size={20} />
                    <span className="mt-1 text-[10px]">{(pf.file.size / 1024).toFixed(0)}KB</span>
                  </div>
                ) : (
                  <div className="flex h-16 w-16 flex-col items-center justify-center rounded-[8px] bg-surface text-xs text-muted">
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
        <div className="composer-shell animate-shell-rise flex flex-col rounded-[12px] p-2">
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
              className="flex-1 resize-none bg-transparent px-3 py-2 text-sm text-text placeholder-muted/60 outline-none"
              autoFocus
            />
            <button
              data-testid="send-button"
              aria-label="Send message"
              onClick={handleSend}
              disabled={isEmpty && pendingFiles.length === 0}
              className={`flex shrink-0 items-center justify-center rounded-[10px] disabled:opacity-30 ${
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
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-red-600 text-white hover:bg-red-700"
              >
                <Square size={16} />
              </button>
            )}
          </div>
          {/* Bottom row: media buttons */}
          <div className="composer-toolbar mt-2 flex items-center gap-0.5 px-1 pt-2">
            <button
              data-testid="attach-button"
              aria-label="Attach file"
              onClick={() => fileInputRef.current?.click()}
              disabled={recording !== null}
              className="glass-icon-button flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] disabled:opacity-30"
              title="Attach files"
            >
              <Paperclip size={16} />
            </button>
            <button
              data-testid="voice-button"
              onClick={() => (recording === "voice" ? stopRecording() : startRecording("voice"))}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${
                recording === "voice"
                  ? "bg-red-600 text-white animate-pulse"
                  : "glass-icon-button"
              } ${recording === "video" ? "opacity-30 pointer-events-none" : ""}`}
              title={recording === "voice" ? "Stop recording" : "Record voice"}
            >
              {recording === "voice" ? <StopCircle size={16} /> : <Mic size={16} />}
            </button>
            <button
              data-testid="video-button"
              onClick={() => (recording === "video" ? stopRecording() : startRecording("video"))}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${
                recording === "video"
                  ? "bg-red-600 text-white animate-pulse"
                  : "glass-icon-button"
              } ${recording === "voice" ? "opacity-30 pointer-events-none" : ""}`}
              title={recording === "video" ? "Stop recording" : "Record video"}
            >
              {recording === "video" ? <StopCircle size={16} /> : <Video size={16} />}
            </button>
            <button
              data-testid="camera-button"
              onClick={cameraStream ? capturePhoto : openCamera}
              disabled={recording !== null}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${
                cameraStream
                  ? "bg-green-600 text-white hover:bg-green-700"
                  : "glass-icon-button"
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
