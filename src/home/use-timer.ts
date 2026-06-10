/**
 * Countdown timer hook with localStorage persistence.
 *
 * Uses absolute-time math (Date.now() vs target epoch) instead of
 * decrementing a counter — drift-resistant over long durations.
 *
 * Adapted from x1ee7/react-drift-timer + LobsterBandit/use-countdown-timer.
 */

import { useEffect, useRef, useState, useCallback } from "react";

const STORAGE_KEY = "octos_home_timer";

interface PersistedTimerState {
  targetTime: number | null;
  totalDuration: number;
  pausedRemaining: number | null;
}

function loadState(): PersistedTimerState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState(state: PersistedTimerState | null) {
  if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  else localStorage.removeItem(STORAGE_KEY);
}

export interface UseTimerReturn {
  remaining: number;
  totalDuration: number;
  isRunning: boolean;
  isPaused: boolean;
  progress: number;
  start: (seconds: number) => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
}

export function useTimer(onExpire: () => void): UseTimerReturn {
  const [targetTime, setTargetTime] = useState<number | null>(null);
  const [totalDuration, setTotalDuration] = useState(0);
  const [pausedRemaining, setPausedRemaining] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const onExpireRef = useRef(onExpire);
  const hasExpiredRef = useRef(false);

  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    const saved = loadState();
    if (!saved) return;
    setTotalDuration(saved.totalDuration);
    if (saved.pausedRemaining !== null) {
      setPausedRemaining(saved.pausedRemaining);
      setRemaining(saved.pausedRemaining);
    } else if (saved.targetTime !== null) {
      const left = Math.max(0, Math.ceil((saved.targetTime - Date.now()) / 1000));
      if (left > 0) {
        setTargetTime(saved.targetTime);
        setRemaining(left);
      } else {
        saveState(null);
        onExpireRef.current();
      }
    }
  }, []);

  useEffect(() => {
    if (targetTime || pausedRemaining !== null) {
      saveState({ targetTime, totalDuration, pausedRemaining });
    }
  }, [targetTime, totalDuration, pausedRemaining]);

  useEffect(() => {
    if (targetTime === null) return;
    hasExpiredRef.current = false;

    const tick = () => {
      const left = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0 && !hasExpiredRef.current) {
        hasExpiredRef.current = true;
        setTargetTime(null);
        saveState(null);
        onExpireRef.current();
      }
    };

    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [targetTime]);

  const start = useCallback((seconds: number) => {
    setTotalDuration(seconds);
    setTargetTime(Date.now() + seconds * 1000);
    setPausedRemaining(null);
    setRemaining(seconds);
    hasExpiredRef.current = false;
  }, []);

  const pause = useCallback(() => {
    if (targetTime === null) return;
    const left = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
    setPausedRemaining(left);
    setTargetTime(null);
    setRemaining(left);
  }, [targetTime]);

  const resume = useCallback(() => {
    if (pausedRemaining === null || pausedRemaining <= 0) return;
    setTargetTime(Date.now() + pausedRemaining * 1000);
    setPausedRemaining(null);
  }, [pausedRemaining]);

  const reset = useCallback(() => {
    setTargetTime(null);
    setPausedRemaining(null);
    setRemaining(0);
    setTotalDuration(0);
    saveState(null);
  }, []);

  return {
    remaining,
    totalDuration,
    isRunning: targetTime !== null,
    isPaused: pausedRemaining !== null,
    progress: totalDuration > 0 ? 1 - remaining / totalDuration : 0,
    start,
    pause,
    resume,
    reset,
  };
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

function beep(frequency: number, duration: number, volume: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      const ctx = getAudioContext();
      const osc = new OscillatorNode(ctx, { frequency, type: "sine" });
      const gain = new GainNode(ctx, { gain: volume });
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.onended = () => resolve();
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration / 1000);
    } catch {
      resolve();
    }
  });
}

export async function timerAlarm(): Promise<void> {
  await beep(523, 150, 0.4);
  await beep(659, 150, 0.5);
  await beep(784, 300, 0.6);
}
