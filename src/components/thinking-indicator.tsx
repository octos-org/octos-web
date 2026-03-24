import { useEffect, useState } from "react";

export function ThinkingIndicator() {
  const [state, setState] = useState<{
    thinking: boolean;
    iteration: number;
  } | null>(null);

  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail;
      setState(detail.thinking ? detail : null);
    }
    window.addEventListener("crew:thinking", handler);
    return () => window.removeEventListener("crew:thinking", handler);
  }, []);

  if (!state) return null;

  return (
    <div data-testid="thinking-indicator" className="flex items-center gap-2 px-4 py-2 text-sm text-muted">
      <span className="flex gap-0.5">
        <span className="animate-bounce" style={{ animationDelay: "0ms" }}>
          .
        </span>
        <span className="animate-bounce" style={{ animationDelay: "150ms" }}>
          .
        </span>
        <span className="animate-bounce" style={{ animationDelay: "300ms" }}>
          .
        </span>
      </span>
      <span>Thinking (iteration {state.iteration})</span>
    </div>
  );
}
