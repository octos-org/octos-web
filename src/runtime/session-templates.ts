import { nextTopicForCommand } from "@/lib/slash-commands";

export type SessionTemplateKind = "chat" | "slides" | "research" | "podcast";

export interface SessionTemplateRecord {
  kind: SessionTemplateKind;
  title: string;
  topic?: string;
}

export interface SessionTemplateStart {
  title: string;
  text: string;
  historyTopic?: string;
}

export const SESSION_TEMPLATE_STORAGE_KEY = "octos_session_templates";

export function loadSessionTemplates(): Record<string, SessionTemplateRecord> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SESSION_TEMPLATE_STORAGE_KEY) || "{}",
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const records: Record<string, SessionTemplateRecord> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const record = value as Partial<SessionTemplateRecord>;
      if (!isSessionTemplateKind(record.kind) || !record.title) continue;
      records[sessionId] = {
        kind: record.kind,
        title: String(record.title),
        ...(record.topic ? { topic: String(record.topic) } : {}),
      };
    }
    return records;
  } catch {
    return {};
  }
}

export function persistSessionTemplates(
  records: Record<string, SessionTemplateRecord>,
): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SESSION_TEMPLATE_STORAGE_KEY, JSON.stringify(records));
}

export function setSessionTemplate(
  records: Record<string, SessionTemplateRecord>,
  sessionId: string,
  record: SessionTemplateRecord,
): Record<string, SessionTemplateRecord> {
  return { ...records, [sessionId]: record };
}

export function clearSessionTemplate(
  records: Record<string, SessionTemplateRecord>,
  sessionId: string,
): Record<string, SessionTemplateRecord> {
  if (!records[sessionId]) return records;
  const next = { ...records };
  delete next[sessionId];
  return next;
}

export function templateDisplayName(kind: SessionTemplateKind): string {
  switch (kind) {
    case "slides":
      return "Slides Studio";
    case "research":
      return "Research";
    case "podcast":
      return "Podcast Studio";
    case "chat":
      return "General Chat";
  }
}

export function buildSessionTemplateStart(
  kind: Exclude<SessionTemplateKind, "chat">,
  rawTitle: string,
): SessionTemplateStart {
  const title = rawTitle.trim();
  if (!title) {
    throw new Error("Template title is required");
  }

  if (kind === "slides") {
    const slug = slugifyTemplateTitle(title);
    const text = `/new slides ${slug}`;
    return {
      title,
      text,
      historyTopic: nextTopicForCommand(text) ?? undefined,
    };
  }

  if (kind === "research") {
    return {
      title,
      text: `Use deep research to investigate ${title}. Run the research workflow directly, keep findings in this session, and produce a concise report with sources.`,
    };
  }

  return {
    title,
    text: `Create a podcast episode about ${title}. Generate the audio deliverable and include a short episode summary in this session.`,
  };
}

function slugifyTemplateTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

function isSessionTemplateKind(value: unknown): value is SessionTemplateKind {
  return (
    value === "chat" ||
    value === "slides" ||
    value === "research" ||
    value === "podcast"
  );
}
