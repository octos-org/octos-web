import { useState, useRef, useEffect } from "react";
import { X, Play, Pause, Music } from "lucide-react";
import type { ContentEntry } from "@/api/content";
import { buildAuthenticatedFileUrl } from "@/api/files";

interface AudioPlayerProps {
  entry: ContentEntry;
  onClose: () => void;
}

function audioUrl(entry: ContentEntry): string {
  return buildAuthenticatedFileUrl(entry.path);
}

export function AudioPlayer({ entry, onClose }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

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
      audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      return;
    }
    setPlaying(false);
  };

  const seekToRatio = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * duration;
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seekToRatio((e.clientX - rect.left) / rect.width);
  };

  const changeSpeed = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const waveform = [
    26, 42, 58, 36, 70, 48, 62, 30, 74, 54, 46, 66, 38, 82, 56, 44,
    68, 50, 76, 34, 60, 48, 72, 40, 64, 52, 86, 44, 58, 36, 70, 46,
  ];

  return (
    <div className="border-t border-border bg-surface-container px-3 py-3">
      <audio ref={audioRef} src={audioUrl(entry)} preload="none" />

      <div className="flex items-center gap-3">
        {/* Icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-link/12 text-link">
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

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-text">
            {entry.filename}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] text-muted w-8">
              {formatTime(currentTime)}
            </span>
            <div
              className="flex h-7 flex-1 cursor-pointer items-end gap-0.5 rounded-md bg-surface-dark/50 px-1.5 py-1"
              onClick={seek}
              role="slider"
              aria-label="Seek audio"
              aria-valuemin={0}
              aria-valuemax={Math.max(1, duration)}
              aria-valuenow={currentTime}
            >
              {waveform.map((height, index) => {
                const filled = (index / Math.max(1, waveform.length - 1)) * 100 <= progress;
                return (
                  <span
                    key={index}
                    className={`flex-1 rounded-sm ${
                      filled ? "bg-accent" : "bg-border"
                    }`}
                    style={{ height: `${height}%` }}
                  />
                );
              })}
            </div>
            <span className="text-[10px] text-muted w-8 text-right">
              {formatTime(duration)}
            </span>
          </div>
          <input
            className="sr-only"
            type="range"
            aria-label="Seek audio"
            min={0}
            max={Math.max(1, duration)}
            step={0.1}
            value={currentTime}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && duration > 0) {
                seekToRatio(next / duration);
              }
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => changeSpeed(rate)}
                className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
                  playbackRate === rate
                    ? "bg-accent text-white"
                    : "bg-surface-light text-muted hover:text-text"
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>

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
