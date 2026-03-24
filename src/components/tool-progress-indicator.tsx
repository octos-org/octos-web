import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

export function ToolProgressIndicator() {
  const [progress, setProgress] = useState<{
    tool: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    function onProgress(e: Event) {
      setProgress((e as CustomEvent).detail);
    }
    function onThinking(e: Event) {
      const detail = (e as CustomEvent).detail;
      // Clear progress when thinking stops (stream done)
      if (!detail.thinking && detail.iteration === 0) {
        setProgress(null);
      }
    }
    window.addEventListener("crew:tool_progress", onProgress);
    window.addEventListener("crew:thinking", onThinking);
    return () => {
      window.removeEventListener("crew:tool_progress", onProgress);
      window.removeEventListener("crew:thinking", onThinking);
    };
  }, []);

  if (!progress) return null;

  return (
    <div data-testid="tool-progress" className="flex items-center gap-2 px-4 py-1 text-xs text-muted">
      <Loader2 size={12} className="animate-spin text-accent" />
      <span className="text-zinc-400">{progress.tool}:</span>
      <span>{progress.message}</span>
    </div>
  );
}
