import { useCallback, useEffect, useMemo, useRef } from "react";

import { ensureSelectedProfileId } from "@/api/client";
import { ChatThread } from "@/components/chat-thread";
import {
  SessionContext,
  useModeState,
  type SessionBeforeSendResult,
  type SessionSendRequest,
} from "@/runtime/session-context";
import { ScopedRuntimeBridge } from "@/runtime/runtime-provider";
import { sendMessage as bridgeSend } from "@/runtime/ui-protocol-send";
import * as ThreadStore from "@/store/thread-store";
import { useThreads, type Thread } from "@/store/thread-store";

// M9-γ-6: the legacy `Message` shape from MessageStore is gone. SitesChat
// only needs a flat list shape for its scaffold-prompt seeding logic;
// keep the minimal subset inline so we don't reintroduce a parallel store.
interface FlatToolCall {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
}
interface FlatMessageFile {
  filename: string;
  path: string;
  caption?: string;
}
interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  clientMessageId?: string;
  responseToClientMessageId?: string;
  files: FlatMessageFile[];
  toolCalls: FlatToolCall[];
  status: "streaming" | "complete" | "error";
  timestamp: number;
  historySeq?: number;
  meta?: { model: string; tokens_in: number; tokens_out: number; duration_s: number };
}

/**
 * Flatten thread-store data into a flat `Message[]` shape SitesChat
 * already iterates over (e.g. for scaffold-prompt seeding). Returns a
 * flat list ordered by user-message send time then per-thread sequence —
 * matches the rendered DOM order.
 */
function flattenThreadsToMessages(threads: Thread[]): Message[] {
  const flatToolCalls = (
    tcs: Array<{ id: string; name: string; status: "running" | "complete" | "error" }>,
  ) => tcs.map((tc) => ({ id: tc.id, name: tc.name, status: tc.status, progress: [] }));

  const out: Message[] = [];
  for (const t of threads) {
    if (t.userMsg.role !== "tool") {
      out.push({
        id: t.userMsg.id,
        role: t.userMsg.role,
        text: t.userMsg.text,
        clientMessageId: t.id,
        files: t.userMsg.files,
        toolCalls: flatToolCalls(t.userMsg.toolCalls),
        status: t.userMsg.status,
        timestamp: t.userMsg.timestamp,
        historySeq: t.userMsg.historySeq,
        meta: t.userMsg.meta,
      });
    }
    for (const r of t.responses) {
      if (r.role === "tool") continue;
      out.push({
        id: r.id,
        role: r.role,
        text: r.text,
        responseToClientMessageId: t.id,
        files: r.files,
        toolCalls: flatToolCalls(r.toolCalls),
        status: r.status,
        timestamp: r.timestamp,
        historySeq: r.historySeq,
        meta: r.meta,
      });
    }
    if (t.pendingAssistant && t.pendingAssistant.role !== "tool") {
      out.push({
        id: t.pendingAssistant.id,
        role: t.pendingAssistant.role,
        text: t.pendingAssistant.text,
        responseToClientMessageId: t.id,
        files: t.pendingAssistant.files,
        toolCalls: flatToolCalls(t.pendingAssistant.toolCalls),
        status: t.pendingAssistant.status,
        timestamp: t.pendingAssistant.timestamp,
        historySeq: t.pendingAssistant.historySeq,
        meta: t.pendingAssistant.meta,
      });
    }
  }
  return out;
}

import { hydrateSiteProjectFromSession } from "../api";
import { useSites } from "../context/sites-context";
import { extractMessageText, inferSitePreset } from "../intake";
import { SITE_PRESETS } from "../types";

interface Props {
  sessionId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function SitesChat({ sessionId }: Props) {
  const { project, save } = useSites();
  const projectRef = useRef(project);
  projectRef.current = project;
  const scaffoldPromiseRef = useRef<Promise<void> | null>(null);
  const projectId = project?.id;
  const projectTitle = project?.title;
  const projectScaffolded = project?.scaffolded;
  const historyTopic = project?.preset ? `site ${project.preset}` : undefined;
  // M10.5: ThreadStore is the single source of truth. SitesChat still
  // reads a flattened `Message[]` for backwards compatibility with its
  // internal scaffold-prompt seeding logic.
  const threads = useThreads(sessionId, historyTopic);
  const messages = useMemo(
    () => flattenThreadsToMessages(threads),
    [threads],
  );

  useEffect(() => {
    void ThreadStore.loadHistory(sessionId, historyTopic);
  }, [historyTopic, sessionId]);

  const ensureSiteScaffolded = useCallback(
    async (request?: SessionSendRequest) => {
      const current = projectRef.current;
      if (!current?.id) return;

      if (scaffoldPromiseRef.current) {
        return scaffoldPromiseRef.current;
      }

      const promise = (async () => {
        save({ scaffoldError: undefined });

        const profileId = current.profileId || (await ensureSelectedProfileId());
        if (!profileId) {
          throw new Error("No active profile selected");
        }

        const existing = await hydrateSiteProjectFromSession(sessionId, profileId);
        if (existing?.slug) {
          save({
            ...existing,
            scaffolded: true,
            profileId,
            scaffoldError: undefined,
          });
          return;
        }

        if (current.scaffolded) {
          save({
            scaffolded: false,
            previewUrl: undefined,
          });
        }

        const lastUserMessage = [...messages]
          .reverse()
          .find((message) => message.role === "user");
        const inferredPreset = inferSitePreset(
          current.preset,
          request?.requestText ||
            extractMessageText(lastUserMessage?.text || "") ||
            current.title ||
            "",
          request?.media || lastUserMessage?.files.map((file) => file.path) || [],
        );

        if (!current.preset) {
          const definition = SITE_PRESETS[inferredPreset];
          save({
            preset: inferredPreset,
            template: definition.template,
            siteKind: definition.siteKind,
            title: current.title || definition.title,
            slug: current.slug || definition.slug,
            profileId,
          });
        }

        // Issue #112.2: pre-fix this POSTed to `/api/chat`, the
        // retired SSE chat transport. Route the scaffold prompt
        // through the WS bridge via `bridgeSend` and wait for the
        // turn lifecycle to complete; the project hydration below
        // is the success signal (the server-side scaffold task
        // persists the project before completing the turn).
        //
        // Codex BLOCK B: include `historyTopic: "site <preset>"` so
        // the scaffold turn lands on the same topic the embedded
        // chat listens on. Without it the turn errored into the
        // root-scope thread store with no bubble visible to the user.
        const scaffoldTopic = `site ${inferredPreset}`;
        await new Promise<void>((resolve) => {
          bridgeSend({
            sessionId,
            historyTopic: scaffoldTopic,
            text: `/new site ${inferredPreset}`,
            media: [],
            onComplete: () => resolve(),
          });
        });

        for (let attempt = 0; attempt < 12; attempt += 1) {
          const hydrated = await hydrateSiteProjectFromSession(sessionId, profileId);
          if (hydrated?.slug) {
            save({
              ...hydrated,
              scaffolded: true,
              profileId,
              scaffoldError: undefined,
            });
            return;
          }
          await sleep(300);
        }

        // Codex BLOCK C: no hydrated slug means the scaffold turn
        // never persisted a project — keep `scaffolded: false` and
        // surface `scaffoldError` so the UI can prompt a retry.
        // The fallback slug is preserved as draft metadata only
        // (so subsequent reattempts share the inferred preset);
        // pre-fix we toggled `scaffolded: true` here, which made a
        // failed scaffold look like success.
        const fallbackSlug =
          current.slug || SITE_PRESETS[inferredPreset].slug;
        save({
          scaffolded: false,
          preset: inferredPreset,
          profileId,
          slug: fallbackSlug,
          previewUrl: undefined,
          scaffoldError: "Site scaffold did not complete; please retry.",
        });
      })()
        .catch((error) => {
          save({
            scaffolded: false,
            previewUrl: undefined,
            scaffoldError:
              error instanceof Error ? error.message : "Site scaffold failed",
          });
          throw error;
        })
        .finally(() => {
          scaffoldPromiseRef.current = null;
        });

      scaffoldPromiseRef.current = promise;
      return promise;
    },
    [messages, save, sessionId],
  );

  useEffect(() => {
    if (!projectId) return;
    void ensureSiteScaffolded();
  }, [ensureSiteScaffolded, projectId, projectScaffolded]);

  const beforeSend = useCallback(
    async (request: SessionSendRequest): Promise<SessionBeforeSendResult> => {
      await ensureSiteScaffolded(request);
      return request;
    },
    [ensureSiteScaffolded],
  );

  const { queueMode, adaptiveMode } = useModeState();

  const sessionValue = useMemo(
    () => ({
      sessions: [],
      currentSessionId: sessionId,
      historyTopic,
      currentSessionTitle: projectTitle || "Site Agent",
      currentSessionStats: null,
      initialMessages: [] as never[],
      activeTaskOnServer: false,
      queueMode,
      adaptiveMode,
      setServerTaskActive: () => {},
      renameSession: () => {},
      updateSessionStats: () => {},
      switchSession: () => {},
      goBack: async () => false,
      createSession: () => sessionId,
      removeSession: async () => {},
      refreshSessions: async () => {},
      markSessionActive: () => {},
      beforeSend,
    }),
    [adaptiveMode, beforeSend, historyTopic, projectTitle, queueMode, sessionId],
  );

  return (
    <SessionContext.Provider value={sessionValue}>
      <ScopedRuntimeBridge>
        <div className="flex h-full flex-col">
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-xs text-muted">
              {projectTitle || "Site Agent"}
            </p>
            <p className="mt-1 text-[11px] text-muted/70">
              {project?.template || "site template"} scaffold runs automatically before edits.
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatThread />
          </div>
        </div>
      </ScopedRuntimeBridge>
    </SessionContext.Provider>
  );
}
