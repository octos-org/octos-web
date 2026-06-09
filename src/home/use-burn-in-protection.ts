/**
 * Burn-in protection hook.
 *
 * 1. Every 3 minutes, micro-shifts the clock position by a random
 *    offset within +/-30px (CSS transform).
 * 2. After 5 minutes of no user interaction, dims the display to
 *    brightness 0.5 (applies a CSS filter on the root element).
 *
 * Returns:
 * - `offset` — { x, y } to feed into `transform: translate(...)`.
 * - `dimmed` — whether the low-brightness mode is active.
 * - `onActivity` — call on any user interaction (touch, mouse, key).
 */

import { useState, useEffect, useCallback, useRef } from "react";

export interface BurnInState {
  offset: { x: number; y: number };
  dimmed: boolean;
  onActivity: () => void;
}

const SHIFT_INTERVAL = 3 * 60 * 1000; // 3 min
const DIM_TIMEOUT = 5 * 60 * 1000; // 5 min
const MAX_OFFSET = 30; // px

function randomOffset(): { x: number; y: number } {
  return {
    x: Math.round((Math.random() - 0.5) * 2 * MAX_OFFSET),
    y: Math.round((Math.random() - 0.5) * 2 * MAX_OFFSET),
  };
}

export function useBurnInProtection(): BurnInState {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dimmed, setDimmed] = useState(false);
  const dimTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lastActivityRef = useRef(0);

  // Reset dim timer
  const resetDim = useCallback(() => {
    lastActivityRef.current = Date.now();
    setDimmed(false);
    clearTimeout(dimTimerRef.current);
    dimTimerRef.current = setTimeout(() => setDimmed(true), DIM_TIMEOUT);
  }, []);

  // Public callback for user interaction events
  const onActivity = useCallback(() => {
    resetDim();
  }, [resetDim]);

  // Periodic clock shift
  useEffect(() => {
    const id = setInterval(() => {
      setOffset(randomOffset());
    }, SHIFT_INTERVAL);
    return () => clearInterval(id);
  }, []);

  // Initial dim timer
  useEffect(() => {
    dimTimerRef.current = setTimeout(() => setDimmed(true), DIM_TIMEOUT);
    return () => clearTimeout(dimTimerRef.current);
  }, []);

  // Global interaction listeners for dim reset
  useEffect(() => {
    const handler = () => onActivity();
    window.addEventListener("mousemove", handler);
    window.addEventListener("touchstart", handler);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("mousemove", handler);
      window.removeEventListener("touchstart", handler);
      window.removeEventListener("keydown", handler);
    };
  }, [onActivity]);

  return { offset, dimmed, onActivity };
}
