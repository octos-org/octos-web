import { useEffect, useState, useMemo } from "react";
import { useThread, useMessage } from "@assistant-ui/react";

interface MessageMetaData {
  model: string;
  tokens_in: number;
  tokens_out: number;
  duration_s: number;
  timestamp: string;
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function MessageMeta() {
  const [meta, setMeta] = useState<MessageMetaData | null>(null);
  const thread = useThread();
  const message = useMessage();

  const timestamp = useMemo(() => {
    const d = message.createdAt ? new Date(message.createdAt) : new Date();
    return formatDate(d);
  }, [message.createdAt]);

  // Only the last assistant message listens for metadata events
  const isLast =
    thread.messages.length > 0 &&
    thread.messages[thread.messages.length - 1].id === message.id;

  useEffect(() => {
    if (!isLast) {
      setMeta(null);
      return;
    }

    function handleMeta(e: Event) {
      const detail = (e as CustomEvent).detail as Omit<MessageMetaData, "timestamp">;
      if (detail.model || detail.tokens_in || detail.tokens_out) {
        setMeta({ ...detail, timestamp: formatDate(new Date()) });
      }
    }
    window.addEventListener("crew:message_meta", handleMeta);
    return () => window.removeEventListener("crew:message_meta", handleMeta);
  }, [isLast]);

  const parts: string[] = [];
  if (meta) {
    if (meta.model) parts.push(meta.model);
    if (meta.tokens_in) parts.push(`${meta.tokens_in.toLocaleString()} in`);
    if (meta.tokens_out) parts.push(`${meta.tokens_out.toLocaleString()} out`);
    if (meta.duration_s) parts.push(`${meta.duration_s}s`);
    if (meta.timestamp) parts.push(meta.timestamp);
  }

  if (parts.length === 0) {
    // No metadata yet — still show timestamp
    return (
      <div className="mt-1.5 text-[10px] text-muted/60 select-none">
        {timestamp}
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted/60 select-none">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent/40" />
      {parts.join(" · ")}
    </div>
  );
}
