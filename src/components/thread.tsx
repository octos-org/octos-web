import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useThreadRuntime,
  useComposerRuntime,
  useThread,
  useComposer,
  useMessage,
} from "@assistant-ui/react";
import { SendHorizontal, Square, Paperclip, X, FileIcon, Mic, Video, Camera, StopCircle } from "lucide-react";
import { useCallback, useState, useRef, useEffect, useMemo } from "react";
import { useSession } from "@/runtime/session-context";
import { uploadFiles } from "@/api/chat";
import { pendingMediaRef } from "@/runtime/runtime-provider";
import { RichMarkdown } from "./markdown-renderer";
import { MessageMeta } from "./message-meta";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolProgressIndicator } from "./tool-progress-indicator";

const MemoizedRichMarkdown = ({ className }: { className?: string }) => (
  <RichMarkdown className={className} />
);

// Stable component reference — prevents React from remounting on every render
const TextComponent = () => (
  <MemoizedRichMarkdown className="prose prose-invert prose-sm max-w-none" />
);

const messageComponents = {
  UserMessage,
  AssistantMessage,
};

export function Thread() {
  const hasMessages = useThread((s) => s.messages.length > 0);

  return (
    <ThreadPrimitive.Root className="flex h-full flex-col min-h-0">
      {hasMessages ? (
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <ThreadPrimitive.Messages
            components={messageComponents}
          />
        </ThreadPrimitive.Viewport>
      ) : (
        <div className="flex flex-1 min-h-0 flex-col items-center justify-center px-4">
          <h1 className="mb-2 text-2xl font-semibold text-text-strong">What can I help with?</h1>
          <p className="mb-8 text-sm text-muted">Ask anything, attach files, or record a voice message.</p>
        </div>
      )}
      <div className="shrink-0">
        <Composer />
      </div>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  const message = useMessage();
  const time = useMemo(() => {
    const d = message.createdAt ? new Date(message.createdAt) : new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }, [message.createdAt]);

  return (
    <MessagePrimitive.Root className="flex justify-end px-4 py-2">
      <div className="flex flex-col items-end">
        <div data-testid="user-message" className="max-w-[80%] rounded-2xl rounded-br-sm bg-user-bubble px-4 py-2 text-sm text-text">
          <MessagePrimitive.Content />
        </div>
        <div className="mt-1 text-[10px] text-muted/60 select-none">{time}</div>
      </div>
    </MessagePrimitive.Root>
  );
}

// Stable components object — avoids creating new function refs on each render
const assistantContentComponents = {
  Text: TextComponent,
};

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex px-4 py-2">
      <div data-testid="assistant-message" className="max-w-[80%] rounded-2xl rounded-bl-sm bg-surface-light px-4 py-3 text-sm text-text transition-all duration-300 ease-out">
        <MessagePrimitive.Content components={assistantContentComponents} />
        <ThinkingIndicator />
        <ToolProgressIndicator />
        <MessageMeta />
      </div>
    </MessagePrimitive.Root>
  );
}

const COMMANDS = [
  { cmd: "/new", desc: "Start a new chat session" },
  { cmd: "/clear", desc: "Clear current session and start fresh" },
  { cmd: "/delete", desc: "Delete current session" },
  { cmd: "/queue", desc: "Set queue mode (collect|steer|interrupt)" },
  { cmd: "/adaptive", desc: "Set routing mode (off|hedge|lane)" },
  { cmd: "/status", desc: "Configure status indicators" },
  { cmd: "/reset", desc: "Reset queue, adaptive, and history" },
];


/** Convert AudioBuffer to WAV Blob. */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  // Interleave channels
  const length = buffer.length * numChannels;
  const samples = new Int16Array(length);
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      samples[i * numChannels + ch] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
  }

  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const buf = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buf);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const output = new Int16Array(buf, headerSize);
  output.set(samples);

  return new Blob([buf], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** File attachment with preview. */
interface PendingFile {
  file: File;
  preview?: string; // data URL for images
  serverPath?: string; // set after upload
}

function Composer() {
  const threadRuntime = useThreadRuntime();
  const composerRuntime = useComposerRuntime();
  const isRunning = useThread((s) => s.isRunning);
  const isEmpty = useComposer((s) => s.isEmpty);
  const text = useComposer((s) => s.text);
  const { createSession, removeSession, currentSessionId } = useSession();
  const [cmdFeedback, setCmdFeedback] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [recording]);

  const startRecording = useCallback(async (mode: "voice" | "video") => {
    try {
      const constraints: MediaStreamConstraints = mode === "voice"
        ? { audio: true }
        : { audio: true, video: { facingMode: "user", width: 640, height: 480 } };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;

      // Show video preview
      if (mode === "video" && videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
        videoPreviewRef.current.play();
      }

      // For voice: record in whatever format the browser supports,
      // then always convert to WAV before sending.
      const recordMime = mode === "voice"
        ? (MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4"
          : "audio/webm")
        : (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm");

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
          // Always convert voice to WAV for server compatibility
          try {
            const arrayBuf = await rawBlob.arrayBuffer();
            const audioCtx = new AudioContext();
            const decoded = await audioCtx.decodeAudioData(arrayBuf);
            blob = audioBufferToWav(decoded);
            ext = "wav";
            fileType = "audio/wav";
            audioCtx.close();
          } catch (e) {
            console.warn("WAV conversion failed, sending raw:", e);
            blob = rawBlob;
            ext = recordMime.includes("mp4") ? "m4a" : "ogg";
            fileType = blob.type;
          }
        } else {
          blob = rawBlob;
          ext = "webm";
          fileType = blob.type;
        }

        const filename = `${mode}-${Date.now()}.${ext}`;
        const file = new File([blob], filename, { type: fileType });

        const pf: PendingFile = { file };
        if (mode === "video") {
          pf.preview = URL.createObjectURL(blob);
        }
        setPendingFiles((prev) => [...prev, pf]);

        // Clean up stream
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null;
      };

      recorder.start(1000); // collect chunks every second
      mediaRecorderRef.current = recorder;
      setRecording(mode);
    } catch (e) {
      setCmdFeedback(`Recording failed: ${e instanceof Error ? e.message : "permission denied"}`);
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

  // Camera preview state
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);

  const openCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 1280, height: 720 },
      });
      setCameraStream(stream);
    } catch (e) {
      setCmdFeedback(`Camera failed: ${e instanceof Error ? e.message : "permission denied"}`);
      setTimeout(() => setCmdFeedback(null), 4000);
    }
  }, []);

  // Wire camera preview
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

    // Stop camera
    cameraStream.getTracks().forEach((t) => t.stop());
    setCameraStream(null);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
      const pf: PendingFile = { file, preview: URL.createObjectURL(blob) };
      setPendingFiles((prev) => [...prev, pf]);
    }, "image/jpeg", 0.9);
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
      if (file.type.startsWith("image/")) {
        pf.preview = URL.createObjectURL(file);
      }
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

  const sendingRef = useRef(false);
  const handleSend = useCallback(async () => {
    if (sendingRef.current) return; // prevent double-send
    if (isEmpty && pendingFiles.length === 0) return;
    const input = composerRuntime.getState().text.trim();

    // Handle slash commands client-side (before setting sendingRef)
    if (input === "/new") {
      composerRuntime.setText("");
      createSession();
      return;
    }
    if (input === "/clear") {
      composerRuntime.setText("");
      removeSession(currentSessionId);
      return;
    }
    if (input === "/delete") {
      composerRuntime.setText("");
      removeSession(currentSessionId);
      return;
    }
    if (input === "/help" || input === "/") {
      composerRuntime.setText("");
      setCmdFeedback("Client: /new, /clear, /delete | Server: /queue <mode>, /adaptive <mode>, /status");
      setTimeout(() => setCmdFeedback(null), 4000);
      return;
    }

    sendingRef.current = true;

    // Upload files first if any
    if (pendingFiles.length > 0) {
      setUploading(true);
      try {
        const paths = await uploadFiles(pendingFiles.map((pf) => pf.file));
        pendingMediaRef.current = paths;
      } catch (e) {
        setCmdFeedback(`Upload failed: ${e instanceof Error ? e.message : "unknown error"}`);
        setTimeout(() => setCmdFeedback(null), 4000);
        setUploading(false);
        sendingRef.current = false;
        return;
      }
      // Clean up previews
      for (const pf of pendingFiles) {
        if (pf.preview) URL.revokeObjectURL(pf.preview);
      }
      setPendingFiles([]);
      setUploading(false);

      // If no text was typed, inject a descriptor so the composer can send
      if (isEmpty) {
        const names = pendingMediaRef.current.map((p) => p.split("/").pop() || "file").join(", ");
        composerRuntime.setText(`[Attached: ${names}]`);
      }
    }

    if (isRunning) {
      threadRuntime.cancelRun();
    }
    composerRuntime.send();
    sendingRef.current = false;
  }, [threadRuntime, composerRuntime, isRunning, isEmpty, createSession, removeSession, currentSessionId, pendingFiles]);

  const handleCancel = useCallback(() => {
    threadRuntime.cancelRun();
  }, [threadRuntime]);

  // Handle paste with images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      addFiles(files);
    }
  }, [addFiles]);

  const showCmdHints = text.startsWith("/") && text.length < 10;
  const matchingCmds = showCmdHints
    ? COMMANDS.filter((c) => c.cmd.startsWith(text))
    : [];

  return (
    <ComposerPrimitive.Root
      className="border-t border-border bg-surface p-4"
      onPaste={handlePaste}
      onSubmit={(e) => {
        e.preventDefault();
        handleSend();
      }}
    >
      <div
        className="mx-auto max-w-3xl"
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
        }}
      >
        {cmdFeedback && (
          <div data-testid="cmd-feedback" className="mb-2 rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
            {cmdFeedback}
          </div>
        )}
        {matchingCmds.length > 0 && (
          <div data-testid="cmd-hints" className="mb-2 flex flex-wrap gap-1">
            {matchingCmds.map((c) => (
              <button
                key={c.cmd}
                onClick={() => {
                  composerRuntime.setText(c.cmd);
                }}
                className="rounded-md bg-surface-light px-2 py-1 text-xs text-zinc-300 hover:bg-accent/20 hover:text-accent"
              >
                <span className="font-mono">{c.cmd}</span>{" "}
                <span className="text-muted">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        {/* Camera preview */}
        {cameraStream && (
          <div className="mb-2 overflow-hidden rounded-lg border border-green-600/40 bg-zinc-900">
            <video ref={cameraPreviewRef} muted playsInline className="h-48 w-full object-cover" />
            <div className="flex items-center justify-between px-3 py-2 bg-zinc-800">
              <span className="text-xs text-zinc-400">Camera preview</span>
              <div className="flex gap-2">
                <button
                  onClick={cancelCamera}
                  className="rounded-md px-3 py-1 text-xs text-zinc-400 hover:text-white hover:bg-zinc-700"
                >
                  Cancel
                </button>
                <button
                  onClick={capturePhoto}
                  className="flex items-center gap-1 rounded-md bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700"
                >
                  <Camera size={12} /> Capture
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Recording indicator */}
        {recording && (
          <div className="mb-2 flex items-center gap-3 rounded-lg bg-red-900/30 border border-red-600/40 px-3 py-2">
            <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            <span className="text-sm text-red-400">
              {recording === "voice" ? "Recording audio" : "Recording video"} — {formatTime(recordingTime)}
            </span>
            <button
              onClick={stopRecording}
              className="ml-auto flex items-center gap-1 rounded-md bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
            >
              <StopCircle size={12} /> Stop
            </button>
          </div>
        )}
        {/* Video preview during recording */}
        {recording === "video" && (
          <div className="mb-2 overflow-hidden rounded-lg border border-border">
            <video ref={videoPreviewRef} muted className="h-48 w-full object-cover" />
          </div>
        )}
        {/* File previews with send prompt */}
        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {pendingFiles.map((pf, i) => (
              <div key={i} className="relative group rounded-lg border border-border bg-surface-light p-1">
                {pf.preview && pf.file.type.startsWith("image/") ? (
                  <img src={pf.preview} alt={pf.file.name} className="h-16 w-16 rounded object-cover" />
                ) : pf.preview && pf.file.type.startsWith("video/") ? (
                  <video src={pf.preview} className="h-16 w-16 rounded object-cover" />
                ) : pf.file.type.startsWith("audio/") ? (
                  <div className="flex h-16 w-16 flex-col items-center justify-center rounded bg-surface text-xs text-muted">
                    <Mic size={20} />
                    <span className="mt-1 text-[10px]">{(pf.file.size / 1024).toFixed(0)}KB</span>
                  </div>
                ) : (
                  <div className="flex h-16 w-16 flex-col items-center justify-center rounded bg-surface text-xs text-muted">
                    <FileIcon size={20} />
                    <span className="mt-1 max-w-[56px] truncate">{pf.file.name.split('.').pop()}</span>
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
        <div className="flex items-end gap-2">
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
          <button
            data-testid="attach-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={recording !== null}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-muted transition hover:text-accent disabled:opacity-30"
            title="Attach files"
          >
            <Paperclip size={18} />
          </button>
          <button
            data-testid="voice-button"
            onClick={() => recording === "voice" ? stopRecording() : startRecording("voice")}
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition ${
              recording === "voice"
                ? "bg-red-600 text-white animate-pulse"
                : "text-muted hover:text-accent"
            } ${recording === "video" ? "opacity-30 pointer-events-none" : ""}`}
            title={recording === "voice" ? "Stop recording" : "Record voice"}
          >
            {recording === "voice" ? <StopCircle size={18} /> : <Mic size={18} />}
          </button>
          <button
            data-testid="video-button"
            onClick={() => recording === "video" ? stopRecording() : startRecording("video")}
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition ${
              recording === "video"
                ? "bg-red-600 text-white animate-pulse"
                : "text-muted hover:text-accent"
            } ${recording === "voice" ? "opacity-30 pointer-events-none" : ""}`}
            title={recording === "video" ? "Stop recording" : "Record video"}
          >
            {recording === "video" ? <StopCircle size={18} /> : <Video size={18} />}
          </button>
          <button
            data-testid="camera-button"
            onClick={cameraStream ? capturePhoto : openCamera}
            disabled={recording !== null}
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition ${
              cameraStream ? "bg-green-600 text-white hover:bg-green-700" : "text-muted hover:text-accent"
            } disabled:opacity-30`}
            title={cameraStream ? "Take photo" : "Open camera"}
          >
            <Camera size={18} />
          </button>
          <ComposerPrimitive.Input
            data-testid="chat-input"
            placeholder={pendingFiles.length > 0 ? `${pendingFiles.length} file(s) attached — add a message...` : "Send a message... (type / for commands)"}
            className="flex-1 resize-none rounded-xl border border-border bg-surface-light px-4 py-3 text-sm text-text placeholder-muted outline-none focus:border-accent"
            autoFocus
          />
          <button
            data-testid="send-button"
            onClick={handleSend}
            disabled={isEmpty && pendingFiles.length === 0}
            className={`flex items-center justify-center rounded-xl transition disabled:opacity-30 ${
              pendingFiles.length > 0
                ? "h-10 gap-1.5 px-4 bg-green-600 text-white hover:bg-green-700"
                : "h-10 w-10 bg-accent text-surface-dark hover:bg-accent-dim"
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
              onClick={handleCancel}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-600 text-white transition hover:bg-red-700"
            >
              <Square size={16} />
            </button>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
