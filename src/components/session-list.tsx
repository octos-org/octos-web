import { useState, useCallback, useMemo, useEffect } from "react";
import { useSession } from "@/runtime/session-context";
import { useAllTasksBySession } from "@/store/task-store";
import { sendMessage as bridgeSend } from "@/runtime/ui-protocol-send";
import {
  buildSessionTemplateStart,
  clearSessionTemplate,
  loadSessionTemplates,
  persistSessionTemplates,
  setSessionTemplate,
  templateDisplayName,
  SESSION_TEMPLATE_STORAGE_KEY,
  type SessionTemplateKind,
  type SessionTemplateRecord,
} from "@/runtime/session-templates";
import {
  Plus,
  MessageSquare,
  Trash2,
  Check,
  X,
  Loader2,
  Presentation,
  Search,
  Mic,
  ArrowLeft,
  Home,
} from "lucide-react";

/**
 * Sidebar session list.
 *
 * All session-fetch / delete traffic goes through `useSession()`, which
 * routes through the `listSessions` / `deleteSession` wrappers in
 * `src/api/sessions.ts`. Those wrappers call the WS UI Protocol v1
 * `session/list` + `session/delete` methods. The legacy REST fallbacks
 * were retired in M12 Phase D-5. This component never calls
 * `request()` or `fetch()` directly — keep it that way to preserve
 * the single transport boundary the wrappers establish.
 */
export function SessionList() {
  const {
    sessions,
    currentSessionId,
    switchSession,
    createSession,
    removeSession,
    markSessionActive,
    refreshSessions,
  } = useSession();
  const taskEntries = useAllTasksBySession();
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [pendingTemplate, setPendingTemplate] =
    useState<Exclude<SessionTemplateKind, "chat"> | null>(null);
  const [templateTitle, setTemplateTitle] = useState("");
  const [sessionTemplates, setSessionTemplates] = useState(loadSessionTemplates);
  const [queuedStart, setQueuedStart] = useState<{
    sessionId: string;
    text: string;
    historyTopic?: string;
  } | null>(null);
  // M9-α-5/α-6 (ADR PR #830): the legacy `StreamManager.isActive` poll
  // (driven by SSE) is gone. The WS bridge owns the active-turn signal
  // via `task/updated` + `turn/started/completed`, which feed
  // `useAllTasksBySession` above; the per-session "currently streaming"
  // pill follows from background task entries until the WS bridge
  // exposes a turn-active selector directly.
  const streamingSessions: Set<string> = useMemo(() => new Set<string>(), []);
  const backgroundTaskSessions: Set<string> = useMemo(() => {
    const s = new Set<string>();
    for (const [sessionId, tasks] of taskEntries) {
      if (tasks.some((t) => t.status === "spawned" || t.status === "running")) {
        s.add(sessionId);
      }
    }
    return s;
  }, [taskEntries]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === SESSION_TEMPLATE_STORAGE_KEY) {
        setSessionTemplates(loadSessionTemplates());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const rememberTemplate = useCallback(
    (sessionId: string, record: SessionTemplateRecord) => {
      setSessionTemplates((prev) => {
        const next = setSessionTemplate(prev, sessionId, record);
        persistSessionTemplates(next);
        return next;
      });
    },
    [],
  );

  const forgetTemplate = useCallback((sessionId: string) => {
    setSessionTemplates((prev) => {
      const next = clearSessionTemplate(prev, sessionId);
      persistSessionTemplates(next);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      await new Promise((r) => setTimeout(r, 250));
      await removeSession(id);
      forgetTemplate(id);
      setConfirmingDelete(null);
    } catch (error) {
      console.error("Failed to delete session", error);
    } finally {
      setDeletingId(null);
    }
  }, [forgetTemplate, removeSession]);

  const closeSelector = useCallback(() => {
    setSelectorOpen(false);
    setPendingTemplate(null);
    setTemplateTitle("");
  }, []);

  const handleTemplatePick = useCallback(
    (kind: SessionTemplateKind) => {
      if (kind === "chat") {
        const sessionId = createSession("General chat");
        rememberTemplate(sessionId, {
          kind,
          title: "General chat",
        });
        closeSelector();
        return;
      }

      setPendingTemplate(kind);
      setTemplateTitle("");
    },
    [closeSelector, createSession, rememberTemplate],
  );

  const handleTemplateSubmit = useCallback(() => {
    if (!pendingTemplate) return;
    const start = buildSessionTemplateStart(pendingTemplate, templateTitle);
    const sessionId = createSession(start.title);
    rememberTemplate(sessionId, {
      kind: pendingTemplate,
      title: start.title,
      ...(start.historyTopic ? { topic: start.historyTopic } : {}),
    });
    setQueuedStart({
      sessionId,
      historyTopic: start.historyTopic,
      text: start.text,
    });
    closeSelector();
  }, [
    closeSelector,
    createSession,
    pendingTemplate,
    rememberTemplate,
    templateTitle,
  ]);

  useEffect(() => {
    if (!queuedStart || queuedStart.sessionId !== currentSessionId) return;
    bridgeSend({
      sessionId: queuedStart.sessionId,
      historyTopic: queuedStart.historyTopic,
      text: queuedStart.text,
      requestText: queuedStart.text,
      media: [],
      onSessionActive: (firstMessage) => markSessionActive(firstMessage),
      onComplete: () => {
        void refreshSessions();
      },
    });
    setQueuedStart(null);
  }, [currentSessionId, markSessionActive, queuedStart, refreshSessions]);

  const pendingTemplateName = pendingTemplate
    ? templateDisplayName(pendingTemplate)
    : "";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="px-3 pb-2 pt-3">
        <button
          data-testid="new-chat-button"
          onClick={() => setSelectorOpen(true)}
          className="glass-pill flex w-full items-center justify-center gap-2.5 rounded-[12px] px-4 py-3 text-sm font-medium text-text hover:text-text-strong"
        >
          <Plus size={16} />
          New chat
        </button>
      </div>
      {selectorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="session-template-title"
        >
          <div className="glass-panel w-full max-w-[440px] rounded-[16px] p-4 shadow-lg">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="shell-kicker">New Session</div>
                <div
                  id="session-template-title"
                  className="mt-1 text-lg font-semibold text-text-strong"
                >
                  {pendingTemplate
                    ? pendingTemplateName
                    : "What can I help with?"}
                </div>
              </div>
              <button
                type="button"
                onClick={closeSelector}
                className="glass-icon-button rounded-[10px] p-2"
                title="Close"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            {pendingTemplate ? (
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted">
                    {pendingTemplate === "slides" ? "Project name" : "Topic"}
                  </span>
                  <input
                    autoFocus
                    value={templateTitle}
                    onChange={(event) => setTemplateTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && templateTitle.trim()) {
                        handleTemplateSubmit();
                      }
                    }}
                    className="w-full rounded-[12px] border border-border bg-surface-container px-3 py-2.5 text-sm text-text outline-none focus:border-accent"
                  />
                </label>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setPendingTemplate(null)}
                    className="glass-pill flex items-center gap-2 rounded-[10px] px-3 py-2 text-xs text-muted hover:text-text"
                  >
                    <ArrowLeft size={13} />
                    Templates
                  </button>
                  <button
                    type="button"
                    onClick={handleTemplateSubmit}
                    disabled={!templateTitle.trim()}
                    className="rounded-[10px] bg-accent px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Create
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {TEMPLATE_OPTIONS.map((option) => {
                  const Icon = TEMPLATE_ICONS[option.kind];
                  return (
                    <button
                      key={option.kind}
                      type="button"
                      onClick={() => handleTemplatePick(option.kind)}
                      className="glass-list-item flex min-h-[92px] flex-col items-start gap-2 rounded-[12px] p-3 text-left text-sm text-text hover:text-text-strong"
                    >
                      <Icon size={18} className={option.iconClassName} />
                      <span className="font-semibold">{option.label}</span>
                      <span className="text-xs text-muted">{option.caption}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
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
              const template = sessionTemplates[s.id];
              const SessionIcon = template
                ? TEMPLATE_ICONS[template.kind]
                : MessageSquare;
              const sessionLabel = template
                ? templateDisplayName(template.kind)
                : "Saved session";
              return (
                <div
                  key={s.id}
                  data-testid={`session-item-${s.id}`}
                  data-session-id={s.id}
                  data-session-template={template?.kind}
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
                          <SessionIcon
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
                            {isBusy ? "Live session" : sessionLabel}
                          </div>
                        </div>
                      </button>
                      <button
                        data-testid="session-delete-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDelete(s.id);
                        }}
                        className="glass-icon-button shrink-0 rounded-[10px] p-1.5 opacity-60 hover:text-red-400 group-hover:opacity-100"
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

const TEMPLATE_OPTIONS: {
  kind: SessionTemplateKind;
  label: string;
  caption: string;
  iconClassName: string;
}[] = [
  {
    kind: "chat",
    label: "Chat",
    caption: "General",
    iconClassName: "text-accent",
  },
  {
    kind: "slides",
    label: "Slides",
    caption: "Studio",
    iconClassName: "text-amber-400",
  },
  {
    kind: "research",
    label: "Research",
    caption: "Deep dive",
    iconClassName: "text-emerald-400",
  },
  {
    kind: "podcast",
    label: "Podcast",
    caption: "Studio",
    iconClassName: "text-fuchsia-400",
  },
];

const TEMPLATE_ICONS: Record<SessionTemplateKind, typeof MessageSquare> = {
  chat: MessageSquare,
  slides: Presentation,
  research: Search,
  podcast: Mic,
  "home-assistant": Home,
};

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
