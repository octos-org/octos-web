/**
 * AuroraOrb — Canvas-based aurora wave animation inside a circular orb.
 *
 * Renders 3 overlapping sine waves with state-driven colors and speed.
 * Uses requestAnimationFrame for smooth 60fps rendering; retina-aware.
 */

import { useEffect, useRef } from "react";
import { Mic } from "lucide-react";
import type { OrbState } from "./voice-orb";

interface AuroraOrbProps {
  state: OrbState;
  onClick: () => void;
  disabled?: boolean;
}

/* ── State → visual config mapping ──────────────────── */
const STATE_CONFIG: Record<
  OrbState,
  { colors: [string, string]; speed: number; center: string }
> = {
  idle:       { colors: ["#8bb8ff", "#a5c4ff"], speed: 0.5, center: "#8bb8ff" },
  listening:  { colors: ["#10b981", "#34d399"], speed: 1.5, center: "#34d399" },
  processing: { colors: ["#8b5cf6", "#a78bfa"], speed: 2.5, center: "#a78bfa" },
  speaking:   { colors: ["#f59e0b", "#fbbf24"], speed: 2.0, center: "#fbbf24" },
};

/* ── Canvas draw routine ────────────────────────────── */
function drawAurora(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  cfg: (typeof STATE_CONFIG)[OrbState],
) {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy);
  const [c1, c2] = cfg.colors;

  // Clip to circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  // Dark base
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(6, 8, 15, 0.95)";
  ctx.fillRect(0, 0, w, h);

  // 3 aurora waves
  for (let i = 0; i < 3; i++) {
    const wt = t * cfg.speed + i * 2.1;
    const yBase = cy + Math.sin(wt * 0.3 + i) * r * 0.2;

    ctx.beginPath();
    ctx.moveTo(0, yBase);
    for (let x = 0; x <= w; x += 4) {
      const y =
        yBase +
        Math.sin(x * 0.02 + wt) * r * 0.15 +
        Math.sin(x * 0.04 + wt * 1.3) * r * 0.1;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, yBase - r * 0.3, 0, yBase + r * 0.3);
    grad.addColorStop(0, c1 + "00");
    grad.addColorStop(0.5, c1 + "40");
    grad.addColorStop(1, c2 + "00");
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Center glow
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.6);
  glow.addColorStop(0, cfg.center + "30");
  glow.addColorStop(1, cfg.center + "00");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/* ── Component ──────────────────────────────────────── */
export function AuroraOrb({ state, onClick, disabled }: AuroraOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    let start: number | null = null;
    const cfg = STATE_CONFIG[state];

    const tick = (ts: number) => {
      if (start === null) start = ts;
      const t = (ts - start) / 1000;
      drawAurora(ctx, rect.width, rect.height, t, cfg);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state]);

  const iconColor =
    state === "listening"
      ? "text-emerald-400"
      : state === "processing"
        ? "text-accent"
        : state === "speaking"
          ? "text-amber-400"
          : "text-white/60";

  return (
    <button
      className="home-voice-orb"
      data-state={state}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      aria-label={
        state === "idle"
          ? "Tap to speak"
          : state === "listening"
            ? "Listening..."
            : state === "processing"
              ? "Processing..."
              : "Speaking..."
      }
      type="button"
    >
      <canvas
        ref={canvasRef}
        className="home-aurora-canvas"
        aria-hidden="true"
      />
      <Mic
        size={32}
        className={`home-voice-orb-icon ${iconColor} transition-colors duration-300`}
      />
    </button>
  );
}
