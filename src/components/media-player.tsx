import { useRef, useState } from "react";
import { Play, Pause, Volume2 } from "lucide-react";

interface MediaPlayerProps {
  src: string;
  type: "audio" | "video";
  title?: string;
}

export function MediaPlayer({ src, type, title }: MediaPlayerProps) {
  const ref = useRef<HTMLAudioElement | HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  function toggle() {
    if (!ref.current) return;
    if (playing) {
      ref.current.pause();
    } else {
      ref.current.play();
    }
    setPlaying(!playing);
  }

  function onTimeUpdate() {
    if (!ref.current) return;
    setProgress(ref.current.currentTime);
  }

  function onLoadedMetadata() {
    if (!ref.current) return;
    setDuration(ref.current.duration);
  }

  function onEnded() {
    setPlaying(false);
    setProgress(0);
  }

  function seekTo(value: number) {
    if (!ref.current || !duration) return;
    ref.current.currentTime = value;
  }

  function formatTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  return (
    <div className="my-2 rounded-lg border border-border bg-surface-light p-3">
      {type === "video" ? (
        <video
          ref={ref as React.RefObject<HTMLVideoElement>}
          src={src}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={onEnded}
          className="mb-2 w-full rounded"
          playsInline
        />
      ) : (
        <audio
          ref={ref as React.RefObject<HTMLAudioElement>}
          src={src}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={onEnded}
        />
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-surface-dark transition hover:bg-accent-dim"
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>

        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={progress}
          onChange={(e) => seekTo(parseFloat(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface-dark accent-accent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
          aria-label="Seek"
        />

        <span className="text-xs tabular-nums text-muted">
          {formatTime(progress)} / {formatTime(duration)}
        </span>

        <Volume2 size={14} className="text-muted" />
      </div>

      {title && (
        <div className="mt-1 truncate text-xs text-muted">{title}</div>
      )}
    </div>
  );
}
