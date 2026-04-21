import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSession } from "@/runtime/session-context";
import { eventMatchesScope } from "@/runtime/event-scope";

export function ToolProgressIndicator() {
  const { currentSessionId, historyTopic } = useSession();
  const [progress, setProgress] = useState<{
    tool: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    function onProgress(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      setProgress(detail);
    }
    function onThinking(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      // Clear progress when thinking stops (response received or stream done)
      if (!detail.thinking) {
        setProgress(null);
      }
    }
    window.addEventListener("crew:tool_progress", onProgress);
    window.addEventListener("crew:thinking", onThinking);
    return () => {
      window.removeEventListener("crew:tool_progress", onProgress);
      window.removeEventListener("crew:thinking", onThinking);
    };
  }, [currentSessionId, historyTopic]);

  if (!progress) return null;

  // Strip [info]/[debug]/[warn] prefixes from tool progress messages
  const cleanMessage = progress.message.replace(/^\[(info|debug|warn|error)\]\s*/i, "");

  return (
    <div data-testid="tool-progress" className="flex items-center gap-2 px-4 py-1 text-xs text-muted">
      <Loader2 size={12} className="animate-spin text-accent" />
      <span className="text-zinc-400">{progress.tool}:</span>
      <span>{cleanMessage}</span>
    </div>
  );
}
