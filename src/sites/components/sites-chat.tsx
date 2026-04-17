import { useCallback, useEffect, useMemo, useRef } from "react";

import { buildApiHeaders, ensureSelectedProfileId } from "@/api/client";
import { ChatThread } from "@/components/chat-thread";
import { API_BASE } from "@/lib/constants";
import {
  SessionContext,
  useModeState,
  type SessionBeforeSendResult,
  type SessionSendRequest,
} from "@/runtime/session-context";
import * as MessageStore from "@/store/message-store";
import { useMessages } from "@/store/message-store";

import { buildSitePreviewUrl, hydrateSiteProjectFromSession } from "../api";
import { useSites } from "../context/sites-context";
import { extractMessageText, inferSitePreset } from "../intake";
import { SITE_PRESETS } from "../types";

interface Props {
  sessionId: string;
}

interface ChatStreamEvent {
  type?: string;
  text?: string;
  content?: string;
}

function parseChatStream(body: string): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload) as ChatStreamEvent);
    } catch {
      // Ignore malformed stream fragments.
    }
  }
  return events;
}

function extractScaffoldError(events: ChatStreamEvent[]): string | null {
  for (const event of events) {
    const text = (event.text || event.content || "").trim();
    const match = text.match(/Site scaffold failed:\s*(.+)$/im);
    if (match) return match[1].trim();
  }
  return null;
}

function hasScaffoldSuccess(events: ChatStreamEvent[]): boolean {
  return events.some((event) => {
    const text = (event.text || event.content || "").trim();
    return /Site project .* created!/i.test(text);
  });
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
  const messages = useMessages(sessionId, historyTopic);

  useEffect(() => {
    void MessageStore.loadHistory(sessionId, historyTopic);
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

        const response = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...buildApiHeaders({}, profileId),
          },
          body: JSON.stringify({
            message: `/new site ${inferredPreset}`,
            session_id: sessionId,
          }),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = await response.text();
        const events = parseChatStream(body);
        const scaffoldError = extractScaffoldError(events);
        if (scaffoldError) {
          throw new Error(scaffoldError);
        }

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

        if (!hasScaffoldSuccess(events)) {
          throw new Error("Site scaffold did not complete");
        }

        const fallbackSlug =
          current.slug || SITE_PRESETS[inferredPreset].slug;
        save({
          scaffolded: true,
          preset: inferredPreset,
          profileId,
          slug: fallbackSlug,
          previewUrl: buildSitePreviewUrl(sessionId, fallbackSlug, profileId),
          scaffoldError: undefined,
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
      setHistoryTopic: () => {},
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
    </SessionContext.Provider>
  );
}
