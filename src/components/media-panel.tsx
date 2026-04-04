import { useAllFiles, type FileEntry } from "@/store/file-store";
import { MediaPlayer } from "./media-player";
import { X, Download, FileIcon, Music, Film, Image, FileText, Loader2 } from "lucide-react";
import { API_BASE } from "@/lib/constants";
import { getToken } from "@/api/client";

interface MediaPanelProps {
  open: boolean;
  onClose: () => void;
}

function isAudio(filename: string) {
  return /\.(mp3|wav|ogg|m4a|opus|flac|aac)$/i.test(filename);
}

function isVideo(filename: string) {
  return /\.(mp4|webm|mov|avi|mkv)$/i.test(filename);
}

function isImage(filename: string) {
  return /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(filename);
}

function fileIcon(filename: string) {
  if (isAudio(filename)) return <Music size={16} className="text-purple-400" />;
  if (isVideo(filename)) return <Film size={16} className="text-blue-400" />;
  if (isImage(filename)) return <Image size={16} className="text-green-400" />;
  return <FileText size={16} className="text-muted" />;
}

function formatSize(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Download a file using fetch with Authorization header, then trigger a browser download. */
async function secureDownload(filePath: string, filename: string) {
  const token = getToken();
  const url = `${API_BASE}/api/files?path=${encodeURIComponent(filePath)}`;
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

function FileItem({ file }: { file: FileEntry }) {
  const audio = isAudio(file.filename);
  const video = isVideo(file.filename);
  const image = isImage(file.filename);

  const handleDownload = (e: React.MouseEvent) => {
    e.preventDefault();
    if (file.blobUrl) {
      // Trigger download from existing blob URL
      const a = document.createElement("a");
      a.href = file.blobUrl;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }
    // Otherwise, use secure fetch-based download to avoid leaking token in URL
    secureDownload(file.filePath, file.filename).catch((err) => {
      console.error("Download failed:", err);
    });
  };

  return (
    <div className="rounded-xl bg-surface-container p-3 transition-colors hover:bg-surface-elevated">
      {/* Header row */}
      <div className="flex items-center gap-2.5">
        {fileIcon(file.filename)}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text">{file.filename}</div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span>{formatTime(file.timestamp)}</span>
            {file.size ? <span>{formatSize(file.size)}</span> : null}
            {file.caption ? <span className="truncate">{file.caption}</span> : null}
          </div>
        </div>
        {file.status === "generating" ? (
          <Loader2 size={16} className="animate-spin text-muted" />
        ) : (
          <button
            onClick={handleDownload}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-dark hover:text-accent"
            title="Download"
          >
            <Download size={14} />
          </button>
        )}
      </div>

      {/* Inline player for audio */}
      {audio && file.blobUrl && (
        <div className="mt-2">
          <MediaPlayer src={file.blobUrl} type="audio" />
        </div>
      )}

      {/* Inline player for video */}
      {video && file.blobUrl && (
        <div className="mt-2">
          <MediaPlayer src={file.blobUrl} type="video" />
        </div>
      )}

      {/* Image preview */}
      {image && file.blobUrl && (
        <div className="mt-2">
          <img
            src={file.blobUrl}
            alt={file.filename}
            className="max-h-48 w-full rounded-lg object-contain"
          />
        </div>
      )}
    </div>
  );
}

export function MediaPanel({ open, onClose }: MediaPanelProps) {
  const files = useAllFiles();

  return (
    <>
      {/* Backdrop on mobile */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={`
          ${open ? "translate-x-0" : "translate-x-full"}
          fixed right-0 top-0 z-50 h-full w-80
          md:relative md:z-auto md:h-auto
          flex flex-col bg-surface-dark border-l border-border
          transition-transform duration-200 ease-out
        `}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <FileIcon size={16} className="text-muted" />
            <span className="text-sm font-medium text-text-strong">Files</span>
            {files.length > 0 && (
              <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                {files.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close media panel"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-surface-container hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-12">
              <FileIcon size={32} className="text-muted/30 mb-3" />
              <p className="text-sm text-muted">No files yet</p>
              <p className="text-xs text-muted/60 mt-1">Files generated during this session will appear here</p>
            </div>
          ) : (
            files.map((file) => <FileItem key={file.id} file={file} />)
          )}
        </div>
      </div>
    </>
  );
}
