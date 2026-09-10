import { useCallback, useEffect, useState } from "react";
import { getIdentityGeneration, getToken } from "@/api/client";
import { listSessions } from "@/api/sessions";
import { hydrateSlidesProjectFromSession } from "@/slides/api";
import { getSlidesProject, upsertSlidesProject } from "@/slides/store";
import { hydrateSiteProjectFromSession } from "@/sites/api";
import { getSiteProject, upsertSiteProject } from "@/sites/store";

let pending: { identity: number; token: string | null; promise: Promise<void> } | null = null;

/** Rediscover server projects while retaining local drafts and edit state. */
export function discoverProjects(): Promise<void> {
  const identity = getIdentityGeneration();
  const token = getToken();
  if (pending?.identity === identity && pending.token === token) return pending.promise;
  const current = () => identity === getIdentityGeneration() && token === getToken();
  const promise = (async () => {
    const sessions = await listSessions();
    if (!current()) return;
    let titles: Record<string, string> = {};
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("octos_session_titles") ?? "{}");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) titles = stored as Record<string, string>;
    } catch { /* An invalid local index is rebuilt from the server. */ }
    const projects = new Map<string, "slides" | "site">();
    for (const session of sessions) {
      const [id, topic = ""] = session.id.split("#", 2);
      if (id.startsWith("slides-") || topic.startsWith("slides ")) projects.set(id, "slides");
      else if (id.startsWith("site-") || topic.startsWith("site ")) projects.set(id, "site");
      else if (id.startsWith("web-")) titles[id] = session.title?.trim() || titles[id] || "Untitled session";
    }
    localStorage.setItem("octos_session_titles", JSON.stringify(titles));
    window.dispatchEvent(new CustomEvent("crew:projects_changed"));
    const queue = [...projects];
    let failures = 0;
    // Bound artifact hydration; a large account must not open hundreds of requests.
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && current()) {
        const [id, kind] = queue.shift()!;
        try {
          if (kind === "slides" && !getSlidesProject(id)) {
            const project = await hydrateSlidesProjectFromSession(id);
            if (project && current()) upsertSlidesProject(project);
          } else if (kind === "site" && !getSiteProject(id)) {
            const project = await hydrateSiteProjectFromSession(id);
            if (project && current()) upsertSiteProject(project);
          }
        } catch { failures++; }
      }
    }));
    if (current()) {
      window.dispatchEvent(new CustomEvent("crew:projects_changed"));
      if (failures) throw new Error("Some saved projects could not be loaded. Please retry.");
    }
  })();
  const entry = { identity, token, promise };
  pending = entry;
  void promise.finally(() => { if (pending === entry) pending = null; }).catch(() => {});
  return promise;
}

export function useProjectDiscovery() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void discoverProjects().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load saved projects.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [attempt]);
  return { loading, error, retry };
}
