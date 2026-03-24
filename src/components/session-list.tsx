import { useState, useCallback } from "react";
import { useSession } from "@/runtime/session-context";
import { Plus, MessageSquare, Trash2, Check, X } from "lucide-react";

export function SessionList() {
  const { sessions, currentSessionId, switchSession, createSession, removeSession } =
    useSession();
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    // Animate out, then delete
    await new Promise((r) => setTimeout(r, 300));
    await removeSession(id);
    setDeletingId(null);
    setConfirmingDelete(null);
  }, [removeSession]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="p-2">
        <button
          data-testid="new-chat-button"
          onClick={createSession}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text hover:bg-surface-light"
        >
          <Plus size={14} />
          New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">No sessions yet</p>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              data-testid={`session-item-${s.id}`}
              data-session-id={s.id}
              data-active={s.id === currentSessionId}
              className={`group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-all duration-300 ${
                deletingId === s.id
                  ? "max-h-0 opacity-0 scale-95 overflow-hidden py-0 my-0 -translate-x-full"
                  : "max-h-20 opacity-100 scale-100"
              } ${
                s.id === currentSessionId
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-surface-light hover:text-text"
              }`}
            >
              {confirmingDelete === s.id ? (
                /* Confirm delete inline */
                <div className="flex flex-1 items-center gap-2 animate-in fade-in">
                  <span className="flex-1 text-xs text-red-400">Delete this chat?</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(s.id);
                    }}
                    className="rounded bg-red-600 p-1 text-white hover:bg-red-700 transition"
                    title="Confirm delete"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingDelete(null);
                    }}
                    className="rounded bg-surface p-1 text-muted hover:text-text transition"
                    title="Cancel"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                /* Normal session item */
                <>
                  <button
                    data-testid="session-switch-button"
                    onClick={() => switchSession(s.id)}
                    className="flex flex-1 items-center gap-2 overflow-hidden"
                  >
                    <MessageSquare size={14} className="shrink-0" />
                    <span className="flex-1 truncate">{formatSessionName(s.id)}</span>
                    <span className="text-xs text-muted">{s.message_count}</span>
                  </button>
                  <button
                    data-testid="session-delete-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingDelete(s.id);
                    }}
                    className="shrink-0 rounded p-1 text-muted opacity-0 hover:bg-red-600/20 hover:text-red-400 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          ))
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
