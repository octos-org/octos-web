/**
 * Timer widget for the home standby view.
 *
 * Shows a circular SVG progress ring with countdown, quick-preset
 * buttons, and pause/resume/reset controls. Plays an ascending
 * 3-note chime via Web Audio API when the timer expires.
 *
 * SVG ring pattern adapted from vydimitrov/react-countdown-circle-timer.
 */

import { useCallback } from "react";
import { Timer, Pause, Play, X } from "lucide-react";
import { useTimer, formatTime, timerAlarm } from "./use-timer";

const PRESETS = [1, 3, 5, 10, 15, 25] as const;

function TimerRing({
  size,
  progress,
  color,
  children,
}: {
  size: number;
  progress: number;
  color: string;
  children: React.ReactNode;
}) {
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * progress;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 0.25s linear" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  );
}

export function TimerWidget() {
  const timer = useTimer(useCallback(() => void timerAlarm(), []));

  const ringColor =
    timer.remaining > 60
      ? "#4ade80"
      : timer.remaining > 10
        ? "#facc15"
        : "#ef4444";

  const idle = !timer.isRunning && !timer.isPaused;

  return (
    <div className="home-widget home-timer-widget mt-4 mx-4 px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <Timer size={16} className="text-emerald-400/70" />
        <span className="text-sm font-medium text-white/50">Timer</span>
      </div>

      {idle ? (
        <div className="flex flex-wrap gap-2 justify-center">
          {PRESETS.map((m) => (
            <button
              key={m}
              onClick={(e) => {
                e.stopPropagation();
                timer.start(m * 60);
              }}
              className="home-timer-preset"
            >
              {m}m
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-4 justify-center">
          <TimerRing size={100} progress={timer.progress} color={ringColor}>
            <span
              className="tabular-nums font-light text-white/90"
              style={{
                fontSize: timer.remaining > 3599 ? "0.9rem" : "1.2rem",
                color: ringColor,
                transition: "color 0.3s",
              }}
            >
              {formatTime(timer.remaining)}
            </span>
            {timer.isPaused && (
              <span className="text-[10px] text-white/30 mt-0.5">PAUSED</span>
            )}
          </TimerRing>

          <div className="flex flex-col gap-2">
            {timer.isRunning && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  timer.pause();
                }}
                className="home-timer-control"
                aria-label="Pause"
              >
                <Pause size={18} />
              </button>
            )}
            {timer.isPaused && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  timer.resume();
                }}
                className="home-timer-control"
                aria-label="Resume"
              >
                <Play size={18} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                timer.reset();
              }}
              className="home-timer-control opacity-50"
              aria-label="Reset"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
