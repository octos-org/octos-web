import { useState, useCallback, useEffect, useMemo } from "react";
import { useSession } from "@/runtime/session-context";
import * as StreamManager from "@/runtime/stream-manager";
import { useAllTasksBySession } from "@/store/task-store";
import { Plus, MessageSquare, Trash2, Check, X, Loader2 } from "lucide-react";

export function SessionList() {
  const { sessions, currentSessionId, activeTaskOnServer, switchSession, createSession, removeSession } =
    useSession();
  const taskEntries = useAllTasksBySession();
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [streamingSessions, setStreamingSessions] = useState<Set<string>>(new Set());

  const backgroundTaskSessions = useMemo(() => {
    const ids = new Set<string>();
    for (const [sessionId, tasks] of taskEntries) {
      if (tasks.some((task) => task.status === "spawned" || task.status === "running")) {
        ids.add(sessionId);
      }
    }
    if (activeTaskOnServer) ids.add(currentSessionId);
    return ids;
  }, [activeTaskOnServer, currentSessionId, taskEntries]);

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
    const interval = setInterval(sync, 3000);
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
      <div className="px-3 pb-2 pt-3">
        <button
          data-testid="new-chat-button"
          onClick={() => createSession()}
          className="glass-pill flex w-full items-center justify-center gap-2.5 rounded-[12px] px-4 py-3 text-sm font-medium text-text hover:text-text-strong"
        >
          <Plus size={16} />
          New chat
        </button>
      </div>
      <div className="px-4 pb-2">
        <div className="shell-kicker">Recent Sessions</div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {sessions.length === 0 ? (
          <div className="shell-empty-state rounded-[12px] px-4 py-6 text-center text-xs text-muted/70">
            No sessions yet
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((s) => {
              const isBusy =
                streamingSessions.has(s.id) ||
                backgroundTaskSessions.has(s.id);
              const isActive = s.id === currentSessionId;
              return (
                <div
                  key={s.id}
                  data-testid={`session-item-${s.id}`}
                  data-session-id={s.id}
                  data-active={isActive}
                  className={`glass-list-item session-row group flex w-full items-center gap-2.5 rounded-[12px] px-4 py-3 text-left text-sm transition-all duration-250 ${
                    deletingId === s.id
                      ? "max-h-0 opacity-0 scale-95 overflow-hidden py-0 my-0 -translate-x-full"
                      : "max-h-20 opacity-100 scale-100"
                  } ${
                    isActive
                      ? "text-text-strong"
                      : "text-muted hover:text-text"
                  }`}
                >
                  {confirmingDelete === s.id ? (
                    <div className="flex flex-1 items-center gap-2 animate-in fade-in">
                      <span className="flex-1 text-xs text-red-400">Delete session?</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(s.id);
                        }}
                        className="rounded-[10px] bg-red-600 p-1.5 text-white hover:bg-red-700"
                        title="Confirm delete"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDelete(null);
                        }}
                        className="glass-icon-button rounded-[10px] p-1.5 text-muted hover:text-text"
                        title="Cancel"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      {isActive && <span className="session-row-rail" aria-hidden="true" />}
                      <button
                        data-testid="session-switch-button"
                        onClick={() => switchSession(s.id)}
                        className={`flex flex-1 items-center gap-2.5 overflow-hidden text-left ${
                          isActive ? "pl-3" : ""
                        }`}
                      >
                        {isBusy ? (
                          <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
                        ) : (
                          <MessageSquare
                            size={15}
                            className={`shrink-0 ${
                              isActive ? "text-accent" : "opacity-60"
                            }`}
                          />
                        )}
                        <div className="min-w-0 flex-1 text-left">
                          <div className="truncate font-medium">
                            {s.title || formatSessionName(s.id)}
                          </div>
                          <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-muted/70">
                            {isBusy ? "Live session" : "Saved session"}
                          </div>
                        </div>
                      </button>
                      <button
                        data-testid="session-delete-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDelete(s.id);
                        }}
                        className="glass-icon-button shrink-0 rounded-[10px] p-1.5 opacity-0 hover:text-red-400 group-hover:opacity-100"
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
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
