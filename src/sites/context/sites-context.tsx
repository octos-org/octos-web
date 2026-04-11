import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

import { getSelectedProfileId } from "@/api/client";

import { buildSitePreviewUrl, fetchSiteSession, listSiteFiles } from "../api";
import { useSiteProject, updateSiteProject } from "../store";
import type { SiteProject } from "../types";

interface SitesContextValue {
  project: SiteProject | undefined;
  save: (update: Partial<SiteProject>) => void;
  reload: () => void;
}

const SitesContext = createContext<SitesContextValue | null>(null);

export function SitesProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const { project, save, reload } = useSiteProject(projectId);
  const projectRef = useRef(project);
  projectRef.current = project;

  useEffect(() => {
    const current = projectRef.current;
    if (!current?.scaffolded || !current.slug) return;

    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function pollProject() {
      try {
        const latest = projectRef.current;
        if (!latest?.slug) return;
        const profileId = latest.profileId || getSelectedProfileId() || undefined;

        const files = await listSiteFiles(`sites/${latest.slug}`, {
          sessionId: latest.id,
          profileId,
        });
        if (stopped) return;

        const session = await fetchSiteSession(latest.slug, files, {
          sessionId: latest.id,
          profileId,
        });
        if (stopped) return;

        if (session) {
          const nextPreviewUrl =
            session.preview_url ||
            buildSitePreviewUrl(latest.id, latest.slug, profileId);
          const nextUpdate: Partial<SiteProject> = {
            title: session.site_name || latest.title,
            template: session.template || latest.template,
            siteKind: session.site_kind || latest.siteKind,
            slug: session.site_slug || latest.slug,
            profileId: profileId || latest.profileId,
            previewUrl: nextPreviewUrl,
          };

          const changed =
            nextUpdate.title !== latest.title ||
            nextUpdate.template !== latest.template ||
            nextUpdate.siteKind !== latest.siteKind ||
            nextUpdate.slug !== latest.slug ||
            nextUpdate.previewUrl !== latest.previewUrl;

          if (changed) {
            updateSiteProject(latest.id, nextUpdate);
            reload();
          }
        } else if (!latest.previewUrl) {
          updateSiteProject(latest.id, {
            profileId: profileId || latest.profileId,
            previewUrl: buildSitePreviewUrl(
              latest.id,
              latest.slug,
              profileId,
            ),
          });
          reload();
        }
      } catch {
        // The site scaffold can still be warming up.
      } finally {
        if (!stopped) pollTimer = setTimeout(pollProject, 5000);
      }
    }

    void pollProject();

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [project?.id, project?.scaffolded, project?.slug, reload]);

  return (
    <SitesContext.Provider value={{ project, save, reload }}>
      {children}
    </SitesContext.Provider>
  );
}

export function useSites() {
  const context = useContext(SitesContext);
  if (!context) throw new Error("useSites must be used within SitesProvider");
  return context;
}
