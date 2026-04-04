import { useState, useRef, useEffect } from "react";
import { X, Play, Pause, Music } from "lucide-react";
import type { ContentEntry } from "@/api/content";
import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";

interface AudioPlayerProps {
  entry: ContentEntry;
  onClose: () => void;
}

function audioUrl(entry: ContentEntry): string {
  const token = getToken();
  const base = `${API_BASE}/api/files?path=${encodeURIComponent(entry.path)}`;
  return token ? `${base}&_token=${token}` : base;
}

export function AudioPlayer({ entry, onClose }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => setPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play();
    }
    setPlaying(!playing);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audio.currentTime = ratio * duration;
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-sidebar px-4 py-2.5">
      <audio ref={audioRef} src={audioUrl(entry)} preload="metadata" />

      <div className="flex items-center gap-3">
        {/* Icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-500/20 text-purple-400">
          <Music className="h-5 w-5" />
        </div>

        {/* Play button */}
        <button
          onClick={togglePlay}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:bg-accent/80"
        >
          {playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4 ml-0.5" />
          )}
        </button>

        {/* Info + progress */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-text">
            {entry.filename}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[10px] text-muted w-8">
              {formatTime(currentTime)}
            </span>
            <div
              className="flex-1 h-1.5 rounded-full bg-surface-container cursor-pointer"
              onClick={seek}
            >
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[10px] text-muted w-8 text-right">
              {formatTime(duration)}
            </span>
          </div>
        </div>

        {/* Close */}
        <button
          onClick={onClose}
          className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-surface-container hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
