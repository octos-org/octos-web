/**
 * High-precision clock hook using requestAnimationFrame.
 *
 * Returns { hours, minutes, seconds } that update every frame so the
 * colon-blink or second-hand stays smooth. The component using this
 * should memoise its render to avoid unnecessary DOM thrash (the hook
 * only triggers a re-render when the *minute* changes, since the
 * standby clock shows HH:MM — seconds are exposed for optional use).
 */

import { useState, useEffect, useRef } from "react";

export interface ClockState {
  hours: string;
  minutes: string;
  seconds: string;
  /** Full Date object for day/month formatting. */
  date: Date;
}

function snapshot(): ClockState {
  const now = new Date();
  return {
    hours: String(now.getHours()).padStart(2, "0"),
    minutes: String(now.getMinutes()).padStart(2, "0"),
    seconds: String(now.getSeconds()).padStart(2, "0"),
    date: now,
  };
}

export function useClock(): ClockState {
  const [state, setState] = useState<ClockState>(snapshot);
  const rafRef = useRef(0);
  const prevMinuteRef = useRef(state.minutes);

  useEffect(() => {
    function tick() {
      const next = snapshot();
      // Only re-render when the displayed minute changes (HH:MM display).
      if (next.minutes !== prevMinuteRef.current || next.hours !== state.hours) {
        prevMinuteRef.current = next.minutes;
        setState(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
