/**
 * Custom chat thread — renders from the negotiated render adapter.
 *
 * Threads are selected from the negotiated render model and rendered as one
 * user bubble + ordered assistant/tool responses + a streaming
 * pending-assistant tail. Supports inline file players, markdown rendering,
 * tool progress, thinking indicators, and message meta.
 */

import {
  useCallback,
  useState,
  useRef,
  useEffect,
  useMemo,
  memo,
  type ReactNode,
} from "react";
import {
  SendHorizontal,
  Square,
  Paperclip,
  X,
  FileIcon,
  RotateCcw,
  Brain,
  Mic,
  Video,
  Camera,
  StopCircle,
  Download,
  Layers,
  Route,
  ChevronDown,
  ChevronRight,
  Check,
} from "lucide-react";
import { useSession } from "@/runtime/session-context";
import {
  rollbackSessionTurns,
  useRollbackBusy,
} from "@/runtime/session-rollback";
import {
  asStoredEffort,
  KNOWN_EFFORT_LEVELS,
  setThinkingEffort,
  useThinkingEffort,
} from "@/store/thinking-store";
import {
  isPlaceholderThread,
  type MessageFile,
  type MessageMeta,
  type Thread,
  type ThreadMessage,
  type ThreadToolCall,
} from "@/store/thread-store";
import { isProjectionV2Enabled } from "@/store/projection-store";
import { useRenderThreads } from "@/store/projection-render-adapter";
import { uploadFiles } from "@/api/chat";
import { compactSession } from "@/api/sessions";
import {
  interruptActiveTurn,
  sendMessage as bridgeSend,
} from "@/runtime/ui-protocol-send";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import { MarkdownContent } from "./markdown-renderer";
import { ThinkingIndicator } from "./thinking-indicator";
import { CompactionIndicator } from "./compaction-indicator";
import { ToolProgressIndicator } from "./tool-progress-indicator";
import { useTasks } from "@/store/task-store";
import { SPAWN_ONLY_TOOL_NAMES } from "@/runtime/spawn-only-tools";
import { GhostBubble } from "./GhostBubble";
import { UserBubbleShell } from "./user-bubble-shell";
import { CopyMarkdownButton } from "./copy-markdown-button";
import { ReaderViewTrigger } from "./reader-view-trigger";
import { buildAuthenticatedFileUrl, buildFileUrl } from "@/api/files";
import { displayFilenameFromPath } from "@/lib/utils";
import { nextTopicForCommand } from "@/lib/slash-commands";
import { getToken } from "@/api/client";

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function visibleAttachmentCaption(caption?: string): string {
  if (!caption) return "";
  if (/^\s*[✓✗]\s+\S+.*\b(completed|failed|error)\b/iu.test(caption.trim())) {
    return "";
  }
  return caption;
}

interface ToolArgumentSummary {
  label: "command" | "path" | "query";
  value: string;
}

function objectArgs(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

function stringifyArg(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => stringifyArg(entry))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

function pickArg(
  args: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = stringifyArg(args[key]);
    if (value) return value;
  }
  return null;
}

function toolArgumentSummary(
  toolCall: ThreadToolCall,
): ToolArgumentSummary | null {
  const args = objectArgs(toolCall.args);
  if (!args) return null;
  const name = toolCall.name.toLowerCase();
  const shellCommand = pickArg(args, ["command", "cmd", "shell_command"]);
  const filePath = pickArg(args, [
    "path",
    "file_path",
    "file",
    "filename",
    "dir",
    "directory",
  ]);
  const searchQuery = pickArg(args, [
    "query",
    "q",
    "pattern",
    "regex",
    "search",
    "needle",
  ]);

  if (
    shellCommand &&
    (name.includes("shell") ||
      name.includes("bash") ||
      name.includes("terminal") ||
      name === "exec" ||
      name === "run_command")
  ) {
    return { label: "command", value: shellCommand };
  }
  if (
    filePath &&
    (name.includes("file") ||
      name.includes("read") ||
      name.includes("write") ||
      name.includes("edit") ||
      name.includes("list_dir") ||
      name.includes("glob"))
  ) {
    return { label: "path", value: filePath };
  }
  if (
    searchQuery &&
    (name.includes("search") || name.includes("grep") || name === "rg")
  ) {
    return { label: "query", value: searchQuery };
  }

  if (shellCommand) return { label: "command", value: shellCommand };
  if (filePath) return { label: "path", value: filePath };
  if (searchQuery) return { label: "query", value: searchQuery };
  return null;
}

// ---------------------------------------------------------------------------
// File attachment renderer
// ---------------------------------------------------------------------------

type BlobUrlState = {
  status: "loading" | "ready" | "error";
  url?: string;
};

/** Fetch a file with auth and return an object URL. */
function useBlobUrl(filePath: string, sessionId?: string): BlobUrlState {
  const isExternal = filePath.startsWith("http");
  const [blobState, setBlobState] = useState<{
    filePath: string;
    sessionId?: string;
    status: "loading" | "ready" | "error";
    url?: string;
  }>({ filePath: "", status: "loading" });

  useEffect(() => {
    if (isExternal) return;

    let revoked = false;
    let url: string | undefined;

    setBlobState({ filePath, sessionId, status: "loading" });
    const token = getToken();
    const apiUrl = buildFileUrl(filePath, { sessionId });
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
        setBlobState({ filePath, sessionId, status: "ready", url });
      })
      .catch(() => {
        if (!revoked) setBlobState({ filePath, sessionId, status: "error" });
      });

    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [filePath, isExternal, sessionId]);

  if (isExternal) return { status: "ready", url: filePath };
  if (blobState.filePath === filePath && blobState.sessionId === sessionId) {
    return { status: blobState.status, url: blobState.url };
  }
  return { status: "loading" };
}

function FileAttachment({ file, sessionId }: { file: MessageFile; sessionId?: string }) {
  const blob = useBlobUrl(file.path, sessionId);
  const blobUrl = blob.url;
  const isVideo = /\.(mp4|webm|mov)$/i.test(file.filename);
  const isAudio = !isVideo && /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(file.filename);
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
    return <AudioAttachment file={file} blobUrl={blobUrl} loadStatus={blob.status} />;
  }

  if (isVideo) {
    return (
      <div className="message-attachment-card rounded-[10px] p-2">
        {blobUrl ? (
          <video controls preload="metadata" className="w-full max-w-sm rounded-[8px]" src={blobUrl} />
        ) : blob.status === "error" ? (
          <div className="flex h-24 items-center justify-center text-xs text-muted">Failed to load</div>
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

  // Generic file attachment — render as a real `<a href>` anchor pointing at
  // the authenticated `/api/files/...` URL (with `?token=` query param). This
  // gives the bubble a clickable, downloadable link whose URL preserves the
  // file extension (so e.g. `.md` reports remain matchable by harness link
  // predicates) while still flowing through the standard auth path. We keep
  // the blob preflight (`useBlobUrl`) as a liveness check: if the auth or
  // path resolution would fail, we surface that as a disabled state rather
  // than rendering a link that 403s when clicked.
  //
  // External URLs (`https://…`, `http://…`) bypass `/api/files` entirely —
  // `useBlobUrl` already short-circuits the fetch for them, and wrapping
  // them through `buildAuthenticatedFileUrl` would point the anchor at our
  // local file endpoint with the literal URL as the path component, which
  // 403s. Pass the original path through untouched so legacy
  // `[file:https://…]` deliveries keep opening.
  const isExternalUrl = /^https?:\/\//i.test(file.path);
  const directHref = isExternalUrl
    ? file.path
    : buildAuthenticatedFileUrl(file.path, { sessionId });
  return blobUrl ? (
    <a
      href={directHref}
      download={file.filename}
      target="_blank"
      rel="noopener noreferrer"
      className="glass-pill inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[10px] px-3 py-2 text-xs text-link hover:text-accent"
      data-file-attachment="true"
    >
      <Download size={14} className="shrink-0" />
      <span className="truncate">{file.filename}</span>
    </a>
  ) : (
    <button
      onClick={handleDownload}
      disabled
      className="glass-pill inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[10px] px-3 py-2 text-xs text-link hover:text-accent disabled:opacity-50"
    >
      <Download size={14} className="shrink-0" />
      <span className="truncate">{file.filename}</span>
    </button>
  );
}

/** Audio attachment — <audio> element only created on first play click. */
function AudioAttachment({
  file,
  blobUrl,
  loadStatus,
}: {
  file: MessageFile;
  blobUrl?: string;
  loadStatus: BlobUrlState["status"];
}) {
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
    <div
      data-testid="audio-attachment"
      data-file-path={file.path}
      data-filename={file.filename}
      className="message-attachment-card rounded-[10px] p-2"
    >
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
        <div className="flex h-8 items-center justify-center text-xs text-muted">
          {loadStatus === "error" ? "Failed to load" : "Loading..."}
        </div>
      )}
    </div>
  );
}

// Token count formatter shared by per-thread message meta.
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
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
  { cmd: "/compact", desc: "Compact conversation context now (frees token budget)" },
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
  source?: "recording" | "upload";
}

// ---------------------------------------------------------------------------
// M9-γ-4: optimistic GhostBubble overlay
//
// Mounted by `Composer.handleSend` after projection v2 is negotiated; lives in
// the `ChatThreadV2` React tree (NOT in `ThreadStore`) and unmounts as
// soon as the projection captures `UserView.client_message_id` matching
// the ghost's cmid.
// ---------------------------------------------------------------------------

interface GhostSpec {
  /** Pinned `client_message_id` — same value the send dispatches with. */
  clientMessageId: string;
  /** What the user typed (visible bubble text). */
  text: string;
  /** Raw files at send time — purely for the ghost row's display. */
  files: File[];
  /** Explicit send/terminal error. Kept alongside the optimistic row so a
   * rejected RPC never makes the user's input silently disappear. */
  failure?: string;
  /** The canonical user row has arrived. Keep this metadata until terminal
   * settlement so a late terminal error can still offer Retry without a
   * duplicate user bubble. */
  settled?: boolean;
  /** Closure that re-issues the original send. The GhostBubble surfaces
   *  it via the Retry button after the 30s timeout. Invoked at most
   *  once per ghost. */
  retry: () => void;
}

/** Stable empty-array reference for the per-bucket ghost lookup so downstream
 * identity comparisons do not churn when the current bucket has no ghosts. */
const EMPTY_GHOSTS: ReadonlyArray<GhostSpec> = Object.freeze([]);

// ---------------------------------------------------------------------------
// Main ChatThread component
// ---------------------------------------------------------------------------

interface ChatThreadProps {
  hideFileOnlyAssistantMessages?: boolean;
}

export function ChatThread({
  hideFileOnlyAssistantMessages = false,
}: ChatThreadProps = {}) {
  return (
    <ChatThreadV2
      hideFileOnlyAssistantMessages={hideFileOnlyAssistantMessages}
    />
  );
}

// ---------------------------------------------------------------------------
// ChatThreadV2 (M8.10 PR #4): real threaded renderer behind the v2 flag.
//
// Iterates threads from the negotiated render selector. For each thread:
//   - renders the user message (right-aligned, glass-pill)
//   - renders assistant + tool responses ordered by intra_thread_seq
//   - renders the pending assistant inline at the end (with streaming dots)
// Tool retries collapse into a single tool-call bubble with retryCount;
// the bubble renders a "×N" badge when retryCount >= 1.
// ---------------------------------------------------------------------------

function threadMessageVisibleText(message: ThreadMessage): string {
  if (message.files.length === 0) return message.text;
  const trimmed = message.text.trim();
  if (/^\[Attached: .*\]$/u.test(trimmed)) return "";
  if (trimmed === "[User sent an image]") return "";
  return message.text;
}

const ThreadUserBubble = memo(function ThreadUserBubble({
  message,
  threadId,
  sessionId,
  historyTopic,
  turnsFromEnd,
}: {
  message: ThreadMessage;
  threadId: string;
  sessionId?: string;
  historyTopic?: string;
  /** 1 = newest user turn. Rewinding AT this bubble drops this turn and
   *  everything after it (`session/rollback num_turns`). */
  turnsFromEnd?: number;
}) {
  const visibleText = threadMessageVisibleText(message);
  // A rollback applying anywhere in this scope disables every Rewind
  // button: rollback counts are RELATIVE ("last N"), so a second click
  // confirmed against pre-trim indices would delete unintended turns
  // (codex #262 P1). The applier itself also refuses concurrent runs.
  const rollbackBusy = useRollbackBusy(sessionId ?? "", historyTopic);
  // Rewind affordance state: idle → confirm (second click required) →
  // busy. Errors render inline under the bubble and reset to idle.
  const [rewindState, setRewindState] = useState<
    "idle" | "confirm" | "busy" | "error"
  >("idle");
  const [rewindError, setRewindError] = useState<string | null>(null);
  // Leaving confirm-state on blur/timeout keeps a stray first click from
  // arming a destructive second click minutes later.
  useEffect(() => {
    if (rewindState !== "confirm") return;
    const timer = setTimeout(() => setRewindState("idle"), 4000);
    return () => clearTimeout(timer);
  }, [rewindState]);

  async function runRewind() {
    if (!sessionId || !turnsFromEnd || turnsFromEnd < 1) return;
    setRewindState("busy");
    setRewindError(null);
    const textForPrefill = visibleText;
    const outcome = await rollbackSessionTurns(
      sessionId,
      historyTopic,
      turnsFromEnd,
    );
    if (!outcome.ok) {
      setRewindState("error");
      setRewindError(
        outcome.reason === "turn_in_progress"
          ? "A turn is running — stop it first."
          : outcome.reason === "no_bridge"
            ? "Not connected."
            : "Rewind failed.",
      );
      setTimeout(() => {
        setRewindState("idle");
        setRewindError(null);
      }, 4000);
      return;
    }
    // The bubble (this component) is unmounted by the store rebuild the
    // moment the rollback applies — no local state reset needed. Hand the
    // dropped prompt to the composer so rewind = edit-and-resend.
    if (textForPrefill) {
      window.dispatchEvent(
        new CustomEvent("crew:composer_prefill", {
          detail: { sessionId, topic: historyTopic, text: textForPrefill },
        }),
      );
    }
  }

  // Visual layout is shared with `<GhostBubble>` via `<UserBubbleShell>`
  // so the optimistic overlay and the canonical user bubble cannot drift
  // (codex BLOCK 4 fix). Only the file-row content differs: the real
  // bubble renders `<FileAttachment>` for server-resolved paths; the
  // ghost renders pending pills for not-yet-uploaded `File` objects.
  const fileRows =
    message.files.length > 0 ? (
      <>
        {message.files.map((f) => (
          <FileAttachment key={f.path} file={f} sessionId={sessionId} />
        ))}
      </>
    ) : null;
  // Rewind control lives in the shell's `trailing` slot (right-aligned
  // under the footer). Subtle at rest; explicit two-click confirm.
  const canRewind = Boolean(sessionId && turnsFromEnd && turnsFromEnd >= 1);
  const rewindControl = canRewind ? (
    <span className="flex items-center gap-1">
      {rewindState === "error" && rewindError && (
        <span
          data-testid="rewind-error"
          className="text-[10px] text-rose-400"
        >
          {rewindError}
        </span>
      )}
      <button
        type="button"
        data-testid={`rewind-to-${threadId}`}
        aria-label={
          rewindState === "confirm"
            ? "Confirm rewind — drops this turn and everything after it"
            : "Rewind to before this message"
        }
        title={
          rewindState === "confirm"
            ? `Drops the last ${turnsFromEnd} turn${turnsFromEnd === 1 ? "" : "s"} — click again to confirm`
            : "Rewind to before this message"
        }
        disabled={rewindState === "busy" || rollbackBusy}
        onClick={() => {
          if (rewindState === "idle" || rewindState === "error") {
            setRewindState("confirm");
          } else if (rewindState === "confirm") {
            void runRewind();
          }
        }}
        className={`flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10px] font-medium transition-opacity ${
          rewindState === "confirm"
            ? "border border-rose-400 text-rose-300"
            : "text-muted opacity-40 hover:opacity-100"
        } disabled:opacity-60`}
      >
        <RotateCcw size={10} />
        {rewindState === "busy"
          ? "Rewinding…"
          : rewindState === "confirm"
            ? "Confirm rewind?"
            : "Rewind"}
      </button>
    </span>
  ) : null;

  return (
    <UserBubbleShell
      text={visibleText || null}
      files={fileRows}
      footer={formatTimestamp(message.timestamp)}
      trailing={rewindControl}
      textTestId="user-message"
      textDataAttributes={{ "data-thread-id": threadId }}
    />
  );
});

function stripProgressLevel(text: string): string {
  return text.replace(/^\[(info|debug|warn|error)\]\s*/i, "");
}

function ToolCallBubble({
  toolCall,
  threadId,
}: {
  toolCall: ThreadToolCall;
  threadId: string;
}) {
  const retryBadge =
    toolCall.retryCount >= 1 ? (
      <span
        data-testid="tool-call-retry-badge"
        data-tool-call-retry-count={toolCall.retryCount}
        className="ml-1 rounded-full bg-amber-500/20 px-1.5 py-px text-[9px] font-semibold text-amber-300"
        title={`Retried ${toolCall.retryCount} time${toolCall.retryCount === 1 ? "" : "s"}`}
      >
        ×{toolCall.retryCount + 1}
      </span>
    ) : null;

  // Per-bubble collapse state (not in the global store — clicking one
  // bubble's toggle must not affect any other bubble). Default to expanded
  // while the tool is still running so the user sees live activity, and
  // auto-collapse once the tool settles so a 300-chip pipeline history
  // doesn't dominate the scrollback after the bubble finalises.
  //
  // SPAWN_ONLY exception (2026-05-22, dspfac UX request): run_pipeline /
  // podcast / mofa_* tools emit dozens of progress chips during their
  // long background runs (~20+ min). The default-expanded surface
  // dominates the chat scrollback. Default these to collapsed so the
  // chat reads cleanly; user can still click to expand on demand.
  const isSpawnOnly = SPAWN_ONLY_TOOL_NAMES.has(toolCall.name);
  const defaultExpanded = toolCall.status === "running" && !isSpawnOnly;
  // `null` means the user has not chosen yet, so expansion follows the
  // status-derived default and auto-collapses once the tool settles.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? defaultExpanded;

  const handleToggle = useCallback(() => {
    setUserExpanded((value) => !(value ?? defaultExpanded));
  }, [defaultExpanded]);

  const progressCount = toolCall.progress.length;
  const latestProgress =
    progressCount > 0 ? toolCall.progress[progressCount - 1] : null;
  const argSummary = toolArgumentSummary(toolCall);
  // Toggle only makes sense when there's more than one chip to hide.
  // For a single-chip list, the "collapsed" view would render the same
  // line as the expanded view, so we skip the chrome.
  const showToggle = progressCount > 1;

  // 2026-05-14 per-tool status icon (sibling to commit `586ce04` which
  // fixed `ToolProgressIndicator`'s leading icon). The bubble's
  // wrapper carries an `animate-pulse` while the call is running, but
  // the user-facing "tool finished" signal was implicit (pulse stops)
  // and easy to miss when a progress message contained the literal
  // word "completed" — a `fm_tts` spawn_only on mini5 surfaced
  // "fm_tts: completed" inside the chip while the bubble kept
  // pulsing, reading visually as a stuck spinner. Mirroring
  // `586ce04`'s gate makes the per-tool affordance explicit:
  //
  //   - `running`  → animated `Loader2` (data-testid='tool-call-status-spinner')
  //   - `complete` → static `Check`    (data-testid='tool-call-status-complete-icon')
  //   - `error`    → static `X`        (data-testid='tool-call-status-error-icon')
  //
  // Status is sourced from `toolCall.status`, which `setToolCallStatus`
  // (handleToolCompleted / handleTaskUpdated path) and
  // `finalizeAssistant` (turn/completed sweep, running → complete)
  // already maintain. The wrapper's `animate-pulse` stays for
  // continuity with prior UX; the icon adds an unambiguous glyph.
  let statusIcon: ReactNode;
  if (toolCall.status === "running") {
    // Three color-cycling bouncing balls (M9 follow-up, 2026-05-22).
    // Keeps the same `data-testid` the legacy `Loader2` carried, so
    // unit + playwright specs that target
    // `[data-testid='tool-call-status-spinner']` still find the
    // running affordance — only the DOM shape changes.
    // codex PR #147 review (MINOR 1, 2026-05-22): the outer wrapper
    // carries `role="img"` + `aria-label` so screen readers announce
    // "running"; `aria-hidden` is moved to the individual visual balls
    // so the decorative shapes are hidden but the accessible name still
    // exposes. Previously the wrapper had BOTH `aria-label` AND
    // `aria-hidden="true"` — the hidden flag won, so AT users got
    // nothing.
    statusIcon = (
      <span
        data-testid="tool-call-status-spinner"
        className="inline-flex items-center gap-[2px]"
        role="img"
        aria-label="running"
      >
        <span
          aria-hidden="true"
          className="tool-ball block h-[5px] w-[5px] rounded-full bg-accent"
          style={{ animationDelay: "0ms" }}
        />
        <span
          aria-hidden="true"
          className="tool-ball block h-[5px] w-[5px] rounded-full bg-accent/70"
          style={{ animationDelay: "150ms" }}
        />
        <span
          aria-hidden="true"
          className="tool-ball block h-[5px] w-[5px] rounded-full bg-accent/40"
          style={{ animationDelay: "300ms" }}
        />
      </span>
    );
  } else if (toolCall.status === "complete") {
    statusIcon = (
      <Check
        size={10}
        className="text-emerald-400"
        data-testid="tool-call-status-complete-icon"
        aria-label="complete"
      />
    );
  } else {
    // status === "error"
    statusIcon = (
      <X
        size={10}
        className="text-red-400"
        data-testid="tool-call-status-error-icon"
        aria-label="error"
      />
    );
  }

  return (
    <div
      data-testid="tool-call-bubble"
      data-thread-id={threadId}
      // Render only when the server actually issued a tool_call_id.
      // Falling back to a synthetic shape would break external
      // correlation (e.g. specs comparing the bubble's id to
      // /api/sessions/:id/tasks[i].tool_call_id).
      data-tool-call-id={toolCall.id || undefined}
      data-tool-call-retry-count={toolCall.retryCount}
      data-tool-status={toolCall.status}
      data-progress-expanded={expanded ? "true" : "false"}
      data-progress-count={progressCount}
      className={`flex flex-col gap-1 rounded-[10px] px-2.5 py-1 text-[10px] font-mono ${
        toolCall.status === "running"
          ? "border-accent/20 bg-accent/14 text-accent animate-pulse"
          : toolCall.status === "error"
            ? "border-red-500/20 bg-red-500/12 text-red-400"
            : "text-muted"
      } glass-pill`}
    >
      <span className="flex items-center gap-1.5">
        {statusIcon}
        <span>
          {toolCall.name || "tool"}
          {retryBadge}
        </span>
      </span>
      {argSummary && (
        <span
          data-testid="tool-call-args"
          data-tool-call-args-kind={argSummary.label}
          title={`${argSummary.label}: ${argSummary.value}`}
          className="flex min-w-0 items-start gap-1 text-[9px] leading-4 opacity-85"
        >
          <span className="shrink-0 text-current/70">{argSummary.label}:</span>
          <span className="min-w-0 break-all">{argSummary.value}</span>
        </span>
      )}
      {progressCount > 0 && (
        <>
          {showToggle && (
            <button
              type="button"
              data-testid="tool-call-runtime-toggle"
              data-thread-id={threadId}
              data-expanded={expanded ? "true" : "false"}
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? "Hide progress updates"
                  : `Show ${progressCount - 1} more progress update${
                      progressCount - 1 === 1 ? "" : "s"
                    }`
              }
              onClick={handleToggle}
              className="mt-1 flex items-center gap-1 self-start rounded-sm px-1 py-0.5 text-[9px] uppercase tracking-wide opacity-70 hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-current/40"
            >
              {expanded ? (
                <ChevronDown size={10} aria-hidden="true" />
              ) : (
                <ChevronRight size={10} aria-hidden="true" />
              )}
              <span>
                {expanded
                  ? `Hide ${progressCount} progress updates`
                  : `Show ${progressCount - 1} more`}
              </span>
            </button>
          )}
          {expanded ? (
            <ul
              data-testid="tool-call-runtime-timeline"
              data-thread-id={threadId}
              data-progress-mode="expanded"
              className="m-0 mt-1 flex list-none flex-col gap-0.5 border-l border-current/20 pl-2"
            >
              {toolCall.progress.map((entry, idx) => (
                <li key={idx} className="opacity-80">
                  {stripProgressLevel(entry.message)}
                </li>
              ))}
            </ul>
          ) : (
            // Collapsed: still show the latest chip text so the user can
            // see current activity at a glance without expanding. The
            // toggle row above shows the hidden-update count and the
            // expand affordance.
            <ul
              data-testid="tool-call-runtime-timeline"
              data-thread-id={threadId}
              data-progress-mode="collapsed"
              className="m-0 mt-1 flex list-none flex-col gap-0.5 border-l border-current/20 pl-2"
            >
              {latestProgress && (
                <li
                  data-testid="tool-call-runtime-latest"
                  className="opacity-80"
                >
                  {stripProgressLevel(latestProgress.message)}
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export const ThreadAssistantBubble = memo(function ThreadAssistantBubble({
  message,
  isStreaming,
  showLiveIndicators,
  threadId,
  sessionId,
}: {
  message: ThreadMessage;
  isStreaming: boolean;
  showLiveIndicators: boolean;
  threadId: string;
  sessionId?: string;
}) {
  // Prefer the explicit thread.id passed by the renderer over the
  // message's own backref so a finalized assistant whose origin tid
  // got rewritten still tags its DOM with the canonical thread bucket.
  const tid = threadId || message.responseToClientMessageId || "";
  // Only finalized assistant messages get the "copy as markdown"
  // affordance — streaming/error bubbles would copy partial content.
  // `showLiveIndicators` covers the in-flight pending case where
  // `status` may briefly be `"complete"` while a follow-on pending is
  // about to spawn; gating on both keeps the icon off the in-flight
  // bubble until the turn truly settles.
  const showCopyButton =
    message.status === "complete" && !showLiveIndicators && !!message.text;
  // 2026-05-14 spawn_only spinner placement fix:
  //
  // Previously the tool-progress spinner was lifted to chat-layout
  // level (above the composer) by commit 86fb70e so it would survive
  // `turn/completed` for spawn_only flows whose `tool/progress`
  // heartbeats arrive AFTER the bubble finalises. That introduced a
  // recurring user-reported UX bug: for `run_pipeline` the
  // "run_pipeline: running ..." badge sat above the input prompt for
  // the entire ~25-min background run, visually detached from the
  // bubble it describes.
  //
  // After commit `1a20b7a` (immutable tool-call updates) the bubble
  // re-renders on every heartbeat — so we can host the spinner row
  // inside the bubble again, anchored to the bubble whose tool calls
  // it reports. The indicator is gated on the bubble having at least
  // one tool call with progress entries (i.e., the tool has actually
  // reported something) so finalised bubbles without tool activity
  // don't render a spinner. For spawn_only flows (run_pipeline /
  // podcast_generate / fm_tts / deep_search / mofa_slides) the
  // foreground `tool/completed` fires immediately (chip status →
  // `complete`) but the BG task keeps adding heartbeat progress
  // entries to the same tool call's `progress[]` — so the indicator
  // stays anchored to the bubble and continues to show the latest
  // heartbeat for the full background duration.
  const showToolProgress = message.toolCalls.some(
    (tc) => tc.progress.length > 0,
  );
  return (
    <div className="chat-message-row chat-message-row-assistant flex py-3">
      <div
        data-testid="assistant-message"
        data-thread-id={tid}
        className="chat-assistant-bubble group/assistant message-card message-card-assistant animate-shell-rise rounded-[14px] rounded-bl-[4px] px-4 py-3 text-sm leading-relaxed text-text"
      >
        {message.text ? (
          <MarkdownContent
            text={message.text}
            className="prose prose-invert prose-sm max-w-none min-w-0 break-words"
          />
        ) : isStreaming && message.toolCalls.length === 0 ? (
          // Streaming-text placeholder dots. Sibling fix to commits
          // 586ce04 / f8717fc, both of which gated their respective
          // leading icons by `toolCall.status` so a settled call
          // stopped animating. Those gates covered the LOADER icons
          // but missed THIS placeholder: when `tool/completed` lands
          // BEFORE `turn/completed` the assistant is still
          // `isStreaming`, `message.text` is still empty (LLM has
          // not yet emitted post-tool text, may never), and the
          // three `animate-pulse` dots render right above a
          // `ToolCallBubble` whose status is already `complete`.
          // From the user's seat the bubble reads
          // "podcast_generate: completed" with a spinner pulsing
          // inside it (mini5 2026-05-15). The tool call's own
          // running / complete / error icon is the unambiguous
          // liveness affordance — gate the dots on
          // `toolCalls.length === 0` so they only surface for plain
          // text turns where they're the only thing on the bubble.
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
              <FileAttachment key={f.path} file={f} sessionId={sessionId} />
            ))}
          </div>
        )}

        {/* Tool calls (retry-collapsed) */}
        {message.toolCalls.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {message.toolCalls.map((tc, idx) => (
              // Fall back to index when the server omitted a
              // tool_call_id so React still has a stable per-render
              // key without us minting a synthetic id.
              <ToolCallBubble key={tc.id || `idx-${idx}`} toolCall={tc} threadId={tid} />
            ))}
          </div>
        )}

        {/* Thinking indicator (only for the in-flight pending assistant).
            Wrapped in a block-level container so the pill-shaped
            `inline-flex` indicator sits cleanly below the tool-card row
            instead of overlapping it (reported on dspfac 2026-05-22:
            "渡劫中…(13s) is overlapped on task status bubble"). */}
        {showLiveIndicators && (
          <div className="mt-2 block">
            <ThinkingIndicator />
          </div>
        )}

        {/* Tool-progress spinner — anchored INSIDE the bubble whose tools
            it reports. The indicator derives its display directly from
            `message.toolCalls[*].progress`, NOT a window event stream:
            with `1a20b7a`'s immutable tool-call updates the bubble
            re-renders on every heartbeat, and reading from the store
            avoids the listener-attach race the event-driven design
            suffered from (the indicator was gated on
            `toolCalls.length > 0` so it didn't exist when the first
            `tool/started` event fired). For spawn_only tools
            (run_pipeline, podcast_generate, fm_tts, deep_search,
            mofa_slides) the foreground `tool/completed` flips the
            chip's `status` to `complete` immediately, but heartbeats
            keep appending progress entries; those land here and
            refresh the row text without needing a separate inflight
            flag. The previous fix (commit 86fb70e) lifted this to
            chat-layout level above the composer; that caused a
            recurring UX bug where `run_pipeline: running` sat above
            the input prompt for the entire ~25 min background run,
            detached from its bubble. */}
        {showToolProgress && <ToolProgressIndicator message={message} />}

        {/* Message footer: meta on the left, action icons on the
            right. Copy + reader-view both render only on finalized
            bubbles with non-empty text; the same `showCopyButton`
            gate suffices for both. */}
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <ThreadMessageMeta message={message} />
          {showCopyButton ? (
            <div className="flex items-center gap-0.5">
              <ReaderViewTrigger content={message.text} />
              <CopyMarkdownButton content={message.text} />
            </div>
          ) : (
            <span aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
});

function ThreadMessageMeta({ message }: { message: ThreadMessage }) {
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
      <div className="flex items-center gap-1.5 text-[10px] text-muted/60 select-none">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent/40" />
        {parts.join(" · ")}
      </div>
    );
  }

  return (
    <div className="text-[10px] text-muted/60 select-none">
      {formatTimestamp(message.timestamp)}
    </div>
  );
}

function isVisibleResponse(
  message: ThreadMessage,
  hideFileOnlyAssistantMessages: boolean,
): boolean {
  if (message.role === "system") return false;
  // Tool result messages get folded into their originating tool-call bubble
  // on the assistant message; rendering them as standalone bubbles would
  // duplicate output (the assistant already shows tool-call status + progress).
  if (message.role === "tool") return false;
  // 2026-05-14 hard-refresh replay fix: mirror the server-side wire
  // filter `is_metadata_only_assistant_row` at the SPA render boundary.
  //
  // The agent's iterative tool-call loop commits an Assistant `Message`
  // per LLM iteration. For a turn whose first LLM iteration emits only
  // `tool_calls` (no rendered text and no media) — the canonical
  // shape that brackets every `tool/started` → `tool/completed` for a
  // spawn_only tool such as `run_pipeline` — the JSONL row has
  // `content=""`, `media=[]` and (server-side) `tool_calls=[...]`.
  //
  // The server's `MessageCommitObserver` suppresses these rows from
  // the LIVE `message/persisted` wire (see `is_metadata_only_assistant_row`
  // in `crates/octos-cli/src/api/ui_protocol.rs`). The legacy REST
  // `session/messages_page` returns the unfiltered JSONL — and its
  // `MessageInfo` shape (handlers.rs:531) strips `tool_calls`. So on
  // a hard refresh `replayHistory` ingests a `ThreadMessage` with
  // `text=""`, `files=[]`, `toolCalls=[]` and renders it as an empty
  // timestamp-only bubble (the recurring user-visible regression).
  //
  // Match predicate: assistant role, no text content, no files, no
  // tool-call data. Live state cannot match this predicate after
  // `tool/started` runs (which populates `toolCalls`), so the spawn_only
  // heartbeat path covered by `chat-thread-heartbeat.test.tsx` is
  // untouched. A finalised bubble with progress chips always carries
  // `toolCalls.length > 0`.
  if (
    message.role === "assistant" &&
    !message.text.trim() &&
    message.files.length === 0 &&
    message.toolCalls.length === 0
  ) {
    return false;
  }
  if (
    hideFileOnlyAssistantMessages &&
    message.role === "assistant" &&
    !message.text.trim() &&
    message.files.length > 0 &&
    message.toolCalls.length === 0
  ) {
    return false;
  }
  return true;
}

function ThreadView({
  thread,
  hideFileOnlyAssistantMessages,
  turnsFromEnd,
}: {
  thread: Thread;
  hideFileOnlyAssistantMessages: boolean;
  /** 1 for the newest user turn, N for the oldest — the `num_turns`
   *  a rewind AT this bubble sends to `session/rollback`. */
  turnsFromEnd: number;
}) {
  const visibleResponses = thread.responses.filter((r) =>
    isVisibleResponse(r, hideFileOnlyAssistantMessages),
  );
  // Drive `showLiveIndicators` from the same TaskStore the header
  // `SessionTaskIndicator` uses. For spawn_only tools (run_pipeline /
  // podcast / mofa_*) the `pendingAssistant.status` flips to
  // "complete" within ~30ms of the ack returning, but the background
  // work runs for minutes — pre-fix the inside-bubble
  // `ThinkingIndicator` unmounted at that 30ms boundary, taking the
  // status_word rotator + elapsed timer with it. The header dock
  // already had the right signal (running task count); we mirror it
  // here so the in-bubble live surface stays visible for the same
  // window. Single-thread cases are unaffected (the streaming gate
  // flips first; the bg-task gate takes over at turn/completed).
  const { currentSessionId, historyTopic } = useSession();
  const sessionTasks = useTasks(currentSessionId, historyTopic);
  const hasRunningBackgroundTask = sessionTasks.some(
    (t) => t.status === "spawned" || t.status === "running",
  );
  return (
    <div data-testid="chat-thread-bundle" data-thread-id={thread.id}>
      {!thread.backgroundChild && (
        <ThreadUserBubble
          message={thread.userMsg}
          threadId={thread.id}
          sessionId={currentSessionId}
          historyTopic={historyTopic}
          turnsFromEnd={turnsFromEnd}
        />
      )}
      {visibleResponses.map((response) => (
        <ThreadAssistantBubble
          key={response.id}
          message={response}
          isStreaming={false}
          showLiveIndicators={false}
          threadId={thread.id}
          sessionId={currentSessionId}
        />
      ))}
      {thread.pendingAssistant && (
        <ThreadAssistantBubble
          key={thread.pendingAssistant.id}
          message={thread.pendingAssistant}
          isStreaming={thread.pendingAssistant.status === "streaming"}
          showLiveIndicators={
            thread.pendingAssistant.status === "streaming" ||
            hasRunningBackgroundTask
          }
          threadId={thread.id}
          sessionId={currentSessionId}
        />
      )}
    </div>
  );
}

function ThreadList({
  threads,
  ghosts,
  sessionId,
  topic,
  onSettleGhost,
  hideFileOnlyAssistantMessages,
}: {
  threads: Thread[];
  ghosts: ReadonlyArray<GhostSpec>;
  sessionId: string;
  topic?: string;
  onSettleGhost: (clientMessageId: string) => void;
  hideFileOnlyAssistantMessages: boolean;
}) {
  // Rewind math (codex #262 P1): `session/rollback` counts persisted
  // USER turns only, but `threads` can contain placeholder orphans
  // (late-event buckets with no user message). Counting those both
  // inflates `num_turns` (rewinding B in [A, B, orphan] would send 2
  // and delete A too) and puts a Rewind button on a non-turn.
  // Placeholders map to 0 → no affordance.
  //
  // Round 2: while ANY orphan placeholder exists in the scope, the
  // local turn list is KNOWN-incomplete — the orphan may be a real
  // persisted turn whose user message simply hasn't hydrated, so every
  // relative index computed from the list may be off by one or more.
  // Withhold ALL rewind affordances (everything maps to 0) until
  // hydration resolves the orphan.
  const turnsFromEndByThreadId = useMemo(() => {
    const byId = new Map<string, number>();
    if (threads.some((t) => isPlaceholderThread(t))) return byId;
    let fromEnd = 0;
    for (let i = threads.length - 1; i >= 0; i -= 1) {
      if (threads[i].backgroundChild) continue;
      fromEnd += 1;
      byId.set(threads[i].id, fromEnd);
    }
    return byId;
  }, [threads]);

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

  // Auto-scroll when threads OR ghosts update — a fresh ghost on send
  // should pull the viewport down just like a real user bubble would.
  useEffect(() => {
    if (stickToBottomRef.current && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [threads, ghosts]);

  return (
    <div
      data-testid="chat-thread"
      data-thread-renderer="v2"
      ref={viewportRef}
      className="chat-thread-viewport flex-1 min-h-0 overflow-y-auto overscroll-contain"
    >
      <div className="chat-thread-inner mx-auto max-w-4xl py-6">
        {threads.map((thread) => (
          <ThreadView
            key={thread.id}
            thread={thread}
            hideFileOnlyAssistantMessages={hideFileOnlyAssistantMessages}
            turnsFromEnd={turnsFromEndByThreadId.get(thread.id) ?? 0}
          />
        ))}
        {ghosts.map((g) => (
          <GhostBubble
            key={g.clientMessageId}
            clientMessageId={g.clientMessageId}
            text={g.text}
            files={g.files}
            sessionId={sessionId}
            topic={topic}
            onSettle={() => onSettleGhost(g.clientMessageId)}
            failure={g.failure}
            settled={g.settled}
            onRetry={g.retry}
          />
        ))}
      </div>
    </div>
  );
}

function ChatThreadV2({
  hideFileOnlyAssistantMessages = false,
}: ChatThreadProps) {
  const { currentSessionId, historyTopic } = useSession();
  const threads = useRenderThreads(currentSessionId, historyTopic);
  // M9-γ-4: optimistic ghost overlay state. Lives here (NOT in
  // ThreadStore) so the renderer can mount/unmount rows without
  // polluting the durable thread reducer. Composer pushes new ghosts
  // via `mountGhost`; GhostBubble fires `onSettle` once the projection
  // captures the matching cmid. We retain settled metadata until terminal
  // outcome so a late failure can offer Retry without duplicating the
  // canonical user bubble.
  //
  // Ghosts are bucketed by `(sessionId, historyTopic)` so a session
  // switch doesn't bleed an in-flight optimistic bubble across to the
  // next view. We render only the ghosts for the current bucket; stale
  // entries in other buckets are dropped lazily by `mountGhost` when
  // the same cmid re-enters, or via `__resetForTests`. No `useEffect`
  // resets a bucket — that's exactly the cascading-rerender pattern the
  // `react-hooks/set-state-in-effect` rule blocks.
  const ghostBucketKey = `${currentSessionId}::${historyTopic ?? ""}`;
  const [ghostsByBucket, setGhostsByBucket] = useState<
    Record<string, GhostSpec[]>
  >({});
  const ghosts = ghostsByBucket[ghostBucketKey] ?? EMPTY_GHOSTS;
  const mountGhost = useCallback(
    (spec: GhostSpec) => {
      setGhostsByBucket((prev) => {
        const cur = prev[ghostBucketKey] ?? [];
        // Idempotent: re-mounting the same cmid (e.g. a retry that mints
        // the same id) replaces the existing entry instead of
        // duplicating.
        const filtered = cur.filter(
          (g) => g.clientMessageId !== spec.clientMessageId,
        );
        return { ...prev, [ghostBucketKey]: [...filtered, spec] };
      });
    },
    [ghostBucketKey],
  );
  const settleGhost = useCallback(
    (clientMessageId: string) => {
      setGhostsByBucket((prev) => {
        const cur = prev[ghostBucketKey];
        if (!cur || cur.length === 0) return prev;
        const next = cur.map((ghost) =>
          ghost.clientMessageId === clientMessageId && !ghost.settled
            ? { ...ghost, settled: true }
            : ghost,
        );
        if (next.every((ghost, index) => ghost === cur[index])) return prev;
        return { ...prev, [ghostBucketKey]: next };
      });
    },
    [ghostBucketKey],
  );
  const unmountGhost = useCallback(
    (clientMessageId: string) => {
      setGhostsByBucket((prev) => {
        const cur = prev[ghostBucketKey];
        if (!cur || cur.length === 0) return prev;
        const next = cur.filter((g) => g.clientMessageId !== clientMessageId);
        if (next.length === cur.length) return prev;
        return { ...prev, [ghostBucketKey]: next };
      });
    },
    [ghostBucketKey],
  );
  const failGhost = useCallback(
    (clientMessageId: string, error: Error) => {
      setGhostsByBucket((prev) => {
        const current = prev[ghostBucketKey] ?? [];
        const next = current.map((ghost) =>
          ghost.clientMessageId === clientMessageId
            ? { ...ghost, failure: error.message || "Send failed." }
            : ghost,
        );
        return next === current ? prev : { ...prev, [ghostBucketKey]: next };
      });
    },
    [ghostBucketKey],
  );
  const completeGhost = useCallback(
    (clientMessageId: string) => {
      setGhostsByBucket((prev) => {
        const cur = prev[ghostBucketKey];
        if (!cur || cur.length === 0) return prev;
        // A terminal error enqueues failGhost before onComplete, so this
        // removes only successful overlays. Failed rows remain visible until
        // the user retries them.
        const next = cur.filter(
          (ghost) =>
            ghost.clientMessageId !== clientMessageId || ghost.failure !== undefined,
        );
        if (next.length === cur.length) return prev;
        return { ...prev, [ghostBucketKey]: next };
      });
    },
    [ghostBucketKey],
  );
  const visibleGhosts = ghosts.filter((ghost) => !ghost.settled || ghost.failure);
  const hasThreads = threads.length > 0;
  const hasGhosts = visibleGhosts.length > 0;

  // Issue #110.2: history hydration is owned by `SessionProvider`
  // (its restored-on-mount effect + switchSession). Pre-fix this
  // effect fired its own `loadThreadHistory` plus 3 retry timers at
  // 2s/5s/12s — multiplying every /chat mount into 4 /messages
  // round-trips that competed with SessionProvider's load. The
  // retries were originally added to recover from SSE-era persistence
  // latency; the M9 WS transport persists synchronously before
  // emitting `message/persisted`, so the retries are obsolete.

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      {/* Mounted ONCE at thread level (codex R3): a per-bubble mount
          duplicated the listener/timer per assistant message, and with
          projection v2 the preflight compaction events can arrive before
          any bubble exists at all. Renders null when idle. */}
      <CompactionIndicator />
      {hasThreads || hasGhosts ? (
        <ThreadList
          threads={threads}
          ghosts={visibleGhosts}
          sessionId={currentSessionId}
          topic={historyTopic}
          onSettleGhost={settleGhost}
          hideFileOnlyAssistantMessages={hideFileOnlyAssistantMessages}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          <div className="chat-empty-card glass-section animate-shell-rise max-w-xl rounded-[12px] px-7 py-9 text-center">
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
      {/* The tool-progress spinner used to mount here at chat-layout
          level (above the composer) so it would survive `turn/completed`
          for spawn_only flows whose `tool/progress` envelopes arrive
          after the bubble finalised. That caused a recurring UX bug
          where the indicator ("run_pipeline: running ...") sat above
          the input prompt for the entire ~25 min `run_pipeline` run,
          detached from its bubble. After the `1a20b7a` immutable
          tool-call updates fix the bubble re-renders on every
          heartbeat, so we can host the spinner inside
          `ThreadAssistantBubble` again (gated on
          `hasRunningToolCall || showLiveIndicators`) and it still
          surfaces for spawn_only — just anchored where the user
          expects it. */}
      <div className="shrink-0">
        <Composer
          mountGhost={mountGhost}
          unmountGhost={unmountGhost}
          failGhost={failGhost}
          completeGhost={completeGhost}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

interface ComposerProps {
  /** M9-γ-4: mount a `<GhostBubble>` overlay for the current send.
   *  Composer calls this when projection v2 is negotiated; otherwise the
   *  legacy `addUserMessage` path keeps producing the optimistic row. */
  mountGhost: (spec: GhostSpec) => void;
  /** Tear down a ghost (used by the Retry path to clear a stale
   *  overlay before re-issuing the send). */
  unmountGhost: (clientMessageId: string) => void;
  failGhost: (clientMessageId: string, error: Error) => void;
  completeGhost: (clientMessageId: string) => void;
}

function Composer({
  mountGhost,
  unmountGhost,
  failGhost,
  completeGhost,
}: ComposerProps) {
  const {
    currentSessionId,
    historyTopic,
    refreshSessions,
    markSessionActive,
    beforeSend,
    queueMode,
    adaptiveMode,
    currentSessionStats,
  } =
    useSession();
  // Wave4-A: surface the live client-side queue depth in the toolbar pill.
  // `currentSessionStats.queue_depth` is updated by the `crew:queue_state`
  // subscription in `session-context.tsx`. Falls back to `null` so the
  // existing `queueMode` literal label still renders for sessions that
  // never push anything onto the queue.
  const queueDepth = currentSessionStats?.queue_depth ?? 0;
  // Thinking-effort selector state (TUI `/thinking` parity). Seeded from
  // the server-persisted value on every `session/open` ack; the send path
  // reads the same store so every user turn carries the choice.
  const thinkingEffort = useThinkingEffort(currentSessionId, historyTopic);
  // Read running state from the negotiated render selector. In v2 this is
  // canonical projection state; old servers still provide legacy threads.
  const threadsForRunning = useRenderThreads(currentSessionId, historyTopic);
  const isRunning = useMemo(
    () =>
      threadsForRunning.some(
        (t) =>
          t.pendingAssistant !== null &&
          t.pendingAssistant.status === "streaming",
      ),
    [threadsForRunning],
  );

  const [text, setText] = useState("");
  const [cmdFeedback, setCmdFeedback] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  // Rewind → edit-and-resend: `ThreadUserBubble` dispatches
  // `crew:composer_prefill` with the dropped user prompt after a
  // successful `session/rollback`, so the user lands with the old text
  // ready to edit. Scope-checked — a prefill for another session/topic
  // (stale event across a fast switch) must not clobber this composer.
  useEffect(() => {
    function onPrefill(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { sessionId?: string; topic?: string; text?: string }
        | undefined;
      if (!detail || typeof detail.text !== "string") return;
      if (detail.sessionId !== currentSessionId) return;
      const evTopic = detail.topic?.trim() || undefined;
      const myTopic = historyTopic?.trim() || undefined;
      if (evTopic !== myTopic) return;
      setText(detail.text);
      textareaRef.current?.focus();
    }
    window.addEventListener("crew:composer_prefill", onPrefill);
    return () =>
      window.removeEventListener("crew:composer_prefill", onPrefill);
  }, [currentSessionId, historyTopic]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  // Recording state
  const [recording, setRecording] = useState<"voice" | "video" | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);

  // Recording timer
  useEffect(() => {
    if (recording) {
      timerRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recording]);

  useEffect(() => {
    if (recording !== "video") return;
    const video = videoPreviewRef.current;
    const stream = mediaStreamRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    void video.play().catch(() => {});

    return () => {
      if (video.srcObject === stream) video.srcObject = null;
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
      // Per-recorder chunk buffer captured in this closure (#245 P2). A
      // shared `chunksRef` raced teardown: `stopRecording` nulls the recorder
      // ref synchronously, but `stop()`'s trailing `dataavailable` fires
      // asynchronously afterwards — if the user started a NEW recording in
      // between (which would have reset the shared buffer), that stale chunk
      // contaminated the new recording's blob. A local array isolates each
      // recording: a late chunk from an old recorder lands in ITS OWN (now
      // unused) buffer, and this recorder's `onstop` builds only from its own.
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = async () => {
        const rawBlob = new Blob(chunks, { type: recordMime });
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
      setRecordingTime(0);
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
    setRecordingTime(0);
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
  }, [cameraStream]);

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
  const [sending, setSending] = useState(false);
  const isEmpty = text.trim().length === 0;

  // Issue #112.3: pair the ref with the React state so the unlock
  // path always clears both. Pre-fix several callers set
  // `sendingRef.current = false` directly; mirroring into state lets
  // the Send/Enter handler disable the button while a send is in
  // flight.
  const releaseSending = useCallback(() => {
    sendingRef.current = false;
    setSending(false);
  }, []);

  const handleSend = useCallback(async () => {
    // Issue #112.3: bail immediately if a previous handleSend has not
    // yet released `sendingRef`. Pre-fix the ref was SET in various
    // success/failure branches but never CHECKED, so spamming Enter
    // (or clicking Send twice within ~10ms) produced duplicate
    // turn/start RPCs — and on the SSE-era code path two parallel
    // `/api/chat` POSTs. Mirror into React state so the Send button
    // can disable itself for the duration.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    if (isEmpty && pendingFiles.length === 0) {
      releaseSending();
      return;
    }
    const trimmedInput = text.trim();
    const input = trimmedInput.startsWith("/") ? text.trimStart() : trimmedInput;

    // M9-γ-4 (codex BLOCK 3): defer the ghost-bubble mount until AFTER
    // every early-return path (slash interception, /help, upload
    // failure, second beforeSend interception). A ghost mounted before
    // those returns leaves a stale optimistic bubble on screen with no
    // matching cmid in flight. We compute the cmid up-front (so the
    // bridge call at the bottom can pin it) but only call `mountGhost`
    // once we're past every return point and `bridgeSend` is about to
    // fire.
    //
    // Snapshot the user-typed visible text + the raw files NOW, before
    // upload mutates `pendingFiles`. The ghost's contents are frozen at
    // send-click — exactly what the user sees in a live bubble — and
    // the same snapshot powers retry (codex BLOCK 2).
    const projectionV2 = isProjectionV2Enabled(currentSessionId, historyTopic);
    const pinnedClientMessageId = projectionV2
      ? crypto.randomUUID()
      : undefined;
    const ghostTextSnapshot = trimmedInput;
    const ghostFilesSnapshot = pendingFiles.map((pf) => pf.file);

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
        releaseSending();
        setText("");
        refreshSessions();
        return;
      }
    } catch (e) {
      setCmdFeedback(
        `Send failed: ${e instanceof Error ? e.message : "unknown error"}`,
      );
      setTimeout(() => setCmdFeedback(null), 4000);
      releaseSending();
      return;
    }

    if (trimmedInput === "/help" || trimmedInput === "/") {
      setText("");
      setCmdFeedback(
        COMMANDS.map((c) => `${c.cmd} — ${c.desc}`).join("\n"),
      );
      setTimeout(() => setCmdFeedback(null), 10000);
      releaseSending();
      return;
    }

    if (trimmedInput === "/compact") {
      // Manual context compaction (CLI `/compact` parity; server
      // `session/compact`, octos#1671). The RPC takes the session key
      // VERBATIM — there is no topic param — so a topic bucket must send
      // its scoped `session#topic` id (the same key the pre-turn context
      // manager is stored under). Progress and the outcome notice render
      // through the server-emitted `context/compaction_started|completed`
      // events (`CompactionIndicator`), so only RPC-level failures (old
      // server, no runtime) surface in the feedback pill here.
      setText("");
      const scopedId = currentSessionId.includes("#")
        ? currentSessionId
        : historyTopic?.trim()
          ? `${currentSessionId}#${historyTopic.trim()}`
          : currentSessionId;
      try {
        await compactSession(scopedId);
      } catch (e) {
        setCmdFeedback(
          `Compact failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
        setTimeout(() => setCmdFeedback(null), 4000);
      }
      releaseSending();
      return;
    }

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
        releaseSending();
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
    const commandTopic = nextTopicForCommand(requestText || messageText);
    const requestedTopic =
      commandTopic === undefined ? historyTopic : (commandTopic ?? undefined);

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
        releaseSending();
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
      releaseSending();
      return;
    }

    // M9-γ-4 (codex BLOCK 3): we're now past every early-return path.
    // Mount the ghost immediately before dispatching `bridgeSend` so
    // the optimistic bubble only appears when the send is actually
    // about to leave the client. Hold onto the original payload so the
    // ghost's Retry button can re-issue the send with a NEW cmid
    // (codex BLOCK 2 — Retry truly resends, not just dismisses).
    let ghostMounted = false;
    if (projectionV2 && pinnedClientMessageId) {
      const cmid = pinnedClientMessageId;
      const retryPayload = {
        ...finalPayload,
        historyTopic: requestedTopic,
      };
      const retryFiles = ghostFilesSnapshot;
      const retryText = ghostTextSnapshot;
      // Recursive-closure factory: each retry mints a fresh cmid and
      // mounts a new ghost; the new ghost's `retry` closure captures
      // the freshly minted cmid so an N-th retry stays consistent.
      const buildRetry = (currentCmid: string): (() => void) => () => {
        unmountGhost(currentCmid);
        const retryCmid = crypto.randomUUID();
        mountGhost({
          clientMessageId: retryCmid,
          text: retryText,
          files: retryFiles,
          retry: buildRetry(retryCmid),
        });
        // Re-issue the send with the new cmid + the same payload.
        // The bridge re-registers the pending cmid so the projection's
        // first envelope on the new thread captures it. Failure of
        // this retry must NOT pollute ThreadStore — the ghost's
        // contract is purely visual.
        bridgeSend({
          ...retryPayload,
          clientMessageId: retryCmid,
          skipOptimisticUserMessage: true,
          onSessionActive: (firstMsg) => markSessionActive(firstMsg),
          onComplete: () => {
            refreshSessions();
            completeGhost(retryCmid);
          },
          onError: (error) => failGhost(retryCmid, error),
        });
        // Release synchronously after the bridge has the request:
        // `bridgeSend` is fire-and-forget and `ui-protocol-send.ts`
        // already serializes via a per-session FIFO. Holding `sending`
        // until `onComplete` (turn/completed) locked the composer for
        // the whole turn — see issue #112.3 follow-up.
        releaseSending();
      };
      mountGhost({
        clientMessageId: cmid,
        text: retryText,
        files: retryFiles,
        retry: buildRetry(cmid),
      });
      ghostMounted = true;
    }

    // Send via the WS UI Protocol bridge (`/api/ui-protocol/ws`).
    // M9-α-5/α-6 deleted the legacy SSE chat transport — `bridgeSend`
    // is the sole entry point now.
    bridgeSend({
      ...finalPayload,
      historyTopic: requestedTopic,
      // M9-γ-4: pin the cmid through the send so the ghost's
      // projection-match predicate sees an envelope tagged with the
      // exact same value. In legacy mode the bridge mints its own as before.
      ...(pinnedClientMessageId !== undefined
        ? { clientMessageId: pinnedClientMessageId }
        : {}),
      // M9-γ-4: tell the bridge to skip the optimistic
      // `ThreadStore.addUserMessage` mirror — we've already mounted a
      // visual `<GhostBubble>` instead. The bridge still registers the
      // pending cmid so the projection's first envelope captures it.
      skipOptimisticUserMessage: ghostMounted,
      onSessionActive: (firstMsg) => markSessionActive(firstMsg),
      onComplete: () => {
        refreshSessions();
        if (pinnedClientMessageId !== undefined) {
          completeGhost(pinnedClientMessageId);
        }
      },
      ...(pinnedClientMessageId !== undefined
        ? { onError: (error: Error) => failGhost(pinnedClientMessageId, error) }
        : {}),
    });
    // Release synchronously after the bridge has the request. The
    // per-session FIFO at `ui-protocol-send.ts:163-291` serializes
    // turn/start RPCs, so the composer can accept a follow-up while
    // the prior turn is still in flight — the bridge queues it. The
    // ~10ms double-tap guard #112.3 intended remains via `sendingRef`
    // being set before `bridgeSend`. Holding it past handoff was
    // overscoped — see issue #112.3 follow-up.
    releaseSending();

    setText("");
  }, [
    text,
    isEmpty,
    pendingFiles,
    currentSessionId,
    historyTopic,
    refreshSessions,
    markSessionActive,
    beforeSend,
    mountGhost,
    unmountGhost,
    failGhost,
    completeGhost,
    releaseSending,
  ]);

  const handleCancel = useCallback(() => {
    // Cancel the in-flight WS turn (v1 path). M9-α-5/α-6 removed the
    // legacy SSE stream destroyer; `interruptTurn` is a no-op when no
    // matching turn is in flight on the bridge.
    const bridge = getActiveBridge(currentSessionId, historyTopic);
    if (bridge) {
      const pendingThread = threadsForRunning.find(
        (t) =>
          t.pendingAssistant !== null &&
          t.pendingAssistant.status === "streaming",
      );
      const pendingTurnId = pendingThread?.turnId ?? pendingThread?.id;
      if (pendingTurnId) {
        // codex #261 rounds 2-3 P1: route through the shared
        // seed-ordering-aware helper — a direct `bridge.interruptTurn`
        // here can reach the bridge queue ahead of a `turn/start` still
        // parked on `whenThinkingSeeded`, no-op server-side, and let
        // the supposedly cancelled turn run.
        void interruptActiveTurn({
          sessionId: currentSessionId,
          historyTopic,
          turnId: pendingTurnId,
          reason: "user cancelled",
        }).catch(() => {
          // best-effort: swallow transport errors.
        });
      }
    }
  }, [currentSessionId, historyTopic, threadsForRunning]);

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
      className="chat-composer-wrap pb-6 pt-2"
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
            <video ref={videoPreviewRef} muted playsInline className="h-48 w-full object-cover" />
          </div>
        )}
        {/* File previews */}
        {pendingFiles.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            {pendingFiles.map((pf, i) => (
              <div key={i} className="chat-file-preview message-attachment-card animate-shell-rise relative group rounded-[10px] p-1.5">
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
        <div className="chat-composer-frame composer-shell animate-shell-rise flex flex-col rounded-[12px] p-2">
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
              className="chat-composer-input flex-1 resize-none bg-transparent px-3 py-2 text-sm text-text placeholder-muted/60 outline-none"
              autoFocus
            />
            <button
              data-testid="send-button"
              aria-label="Send message"
              onClick={handleSend}
              // Issue #112.3: also disable while a send is in flight
              // so a quick second click cannot race the first.
              disabled={(isEmpty && pendingFiles.length === 0) || sending}
              className={`chat-send-button flex shrink-0 items-center justify-center rounded-[10px] disabled:opacity-30 ${
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
                className="chat-stop-button flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-red-600 text-white hover:bg-red-700"
              >
                <Square size={16} />
              </button>
            )}
          </div>
          {/* Bottom row: media buttons */}
          <div className="chat-composer-toolbar composer-toolbar mt-2 flex items-center gap-0.5 px-1 pt-2">
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
            {/* Mode indicator badges. Wave4-A: `queueDepth` is the live
                count of turns parked behind the in-flight gate (see
                `ui-protocol-send.ts`); we render it whenever a queued
                turn exists OR a legacy `queueMode` label is set, so
                "N queued" appears regardless of whether the session
                also has a `queueMode` label. */}
            {/* Thinking-effort selector (TUI `/thinking` parity). Value is
                per-session and server-persisted via `turn/start`;
                "Default" omits the wire field, which also clears the
                server's stored override on the next send. */}
            <label
              className="glass-icon-button ml-auto flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-[10px] px-2"
              title="Thinking effort for this session"
            >
              <Brain size={14} className="shrink-0" />
              <select
                data-testid="thinking-effort-select"
                aria-label="Thinking effort"
                value={thinkingEffort ?? ""}
                onChange={(e) =>
                  setThinkingEffort(
                    currentSessionId,
                    asStoredEffort(e.target.value),
                    historyTopic,
                  )
                }
                className="cursor-pointer bg-transparent text-[11px] font-medium text-text-strong outline-none"
              >
                <option value="">Thinking: default</option>
                <option value="low">Thinking: low</option>
                <option value="medium">Thinking: medium</option>
                <option value="high">Thinking: high</option>
                <option value="max">Thinking: max</option>
                {/* A newer server can persist a tier this client does
                    not know; keep it selectable so it round-trips
                    verbatim instead of being destroyed by omission
                    (codex #261 P2). */}
                {thinkingEffort !== null &&
                  !(KNOWN_EFFORT_LEVELS as readonly string[]).includes(
                    thinkingEffort,
                  ) && (
                    <option value={thinkingEffort}>
                      Thinking: {thinkingEffort}
                    </option>
                  )}
              </select>
            </label>
            {(queueMode || adaptiveMode || queueDepth > 0) && (
              <div className="flex items-center gap-1.5">
                {(queueMode || queueDepth > 0) && (
                  <span
                    data-testid="queue-mode-badge"
                    className="mode-badge flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    title={
                      queueDepth > 0
                        ? `${queueDepth} queued${queueMode ? ` (${queueMode})` : ""}`
                        : `Queue mode: ${queueMode}`
                    }
                  >
                    <Layers size={10} />
                    {queueDepth > 0 ? `${queueDepth} queued` : queueMode}
                  </span>
                )}
                {adaptiveMode && (
                  <span
                    data-testid="adaptive-mode-badge"
                    className="mode-badge flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    title={`Adaptive routing: ${adaptiveMode}`}
                  >
                    <Route size={10} />
                    {adaptiveMode}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
