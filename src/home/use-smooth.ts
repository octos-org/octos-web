/**
 * Smooth text streaming animation hook.
 *
 * When `isStreaming` is true, the returned string gradually catches up to
 * `targetText` using requestAnimationFrame, giving a typewriter effect.
 * Speed adapts: the more characters remaining, the faster per-char rate.
 * When streaming stops, the full text is returned immediately.
 */
import { useEffect, useRef, useState } from "react";

export function useSmooth(targetText: string, isStreaming: boolean): string {
  const [displayText, setDisplayText] = useState(targetText);
  const rafRef = useRef<number>(0);
  const posRef = useRef(0);

  useEffect(() => {
    // When not streaming, show full text immediately.
    if (!isStreaming) {
      cancelAnimationFrame(rafRef.current);
      posRef.current = targetText.length;
      setDisplayText(targetText);
      return;
    }

    // If target shrunk (new message), reset position.
    if (posRef.current > targetText.length) {
      posRef.current = 0;
    }

    function tick() {
      const remaining = targetText.length - posRef.current;
      if (remaining <= 0) {
        // Caught up — wait for more tokens.
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Adaptive speed: more remaining chars → bigger step.
      const step = Math.max(1, Math.ceil(remaining / 8));
      posRef.current = Math.min(posRef.current + step, targetText.length);
      setDisplayText(targetText.slice(0, posRef.current));
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [targetText, isStreaming]);

  return displayText;
}
