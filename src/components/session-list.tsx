import { useState, useCallback, useEffect } from "react";
import { useSession } from "@/runtime/session-context";
import * as StreamManager from "@/runtime/stream-manager";
import { Plus, MessageSquare, Trash2, Check, X, Loader2 } from "lucide-react";

export function SessionList() {
  const { sessions, currentSessionId, switchSession, createSession, removeSession } =
    useSession();
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [streamingSessions, setStreamingSessions] = useState<Set<string>>(new Set());

  useEffect(() => {
    const sync = () => {
      setStreamingSessions((prev) => {
        const next = new Set<string>();
        for (const s of sessions) {
          if (StreamManager.isActive(s.id)) next.add(s.id);
        }
        if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
    };
    sync();
    const onStreamChange = () => sync();
    window.addEventListener("crew:stream_state", onStreamChange);
    const interval = setInterval(sync, 1000);
    return () => {
      window.removeEventListener("crew:stream_state", onStreamChange);
      clearInterval(interval);
    };
  }, [sessions]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    await new Promise((r) => setTimeout(r, 250));
    await removeSession(id);
    setDeletingId(null);
    setConfirmingDelete(null);
  }, [removeSession]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="px-3 pb-1">
        <button
          data-testid="new-chat-button"
          onClick={createSession}
          className="flex w-full items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm text-text hover:bg-surface-container"
        >
          <Plus size={16} />
          New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {sessions.length === 0 ? (
          <p className="px-4 py-6 text-xs text-muted/60">No sessions yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((s) => (
              <div
                key={s.id}
                data-testid={`session-item-${s.id}`}
                data-session-id={s.id}
                data-active={s.id === currentSessionId}
                className={`group flex w-full items-center gap-2.5 rounded-xl px-4 py-2.5 text-left text-sm transition-all duration-250 ${
                  deletingId === s.id
                    ? "max-h-0 opacity-0 scale-95 overflow-hidden py-0 my-0 -translate-x-full"
                    : "max-h-20 opacity-100 scale-100"
                } ${
                  s.id === currentSessionId
                    ? "bg-accent-container text-accent"
                    : "text-muted hover:bg-surface-container hover:text-text"
                }`}
              >
                {confirmingDelete === s.id ? (
                  <div className="flex flex-1 items-center gap-2 animate-in fade-in">
                    <span className="flex-1 text-xs text-red-400">Delete?</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(s.id);
                      }}
                      className="rounded-lg bg-red-600 p-1.5 text-white hover:bg-red-700"
                      title="Confirm delete"
                    >
                      <Check size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingDelete(null);
                      }}
                      className="rounded-lg bg-surface-container p-1.5 text-muted hover:text-text"
                      title="Cancel"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      data-testid="session-switch-button"
                      onClick={() => switchSession(s.id)}
                      className="flex flex-1 items-center gap-2.5 overflow-hidden"
                    >
                      {streamingSessions.has(s.id) ? (
                        <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
                      ) : (
                        <MessageSquare size={15} className="shrink-0 opacity-60" />
                      )}
                      <span className="flex-1 truncate">{s.title || formatSessionName(s.id)}</span>
                    </button>
                    <button
                      data-testid="session-delete-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingDelete(s.id);
                      }}
                      className="shrink-0 rounded-lg p-1 text-muted opacity-0 hover:bg-red-600/20 hover:text-red-400 group-hover:opacity-100"
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatSessionName(id: string): string {
  if (id.startsWith("web-")) {
    const parts = id.split("-");
    if (parts.length >= 2) {
      const ts = parseInt(parts[1], 10);
      if (!isNaN(ts)) {
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }
    }
  }
  return id;
}
