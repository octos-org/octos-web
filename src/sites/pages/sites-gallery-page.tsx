import { ArrowLeft, Globe, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { SITE_PRESETS, type SitePreset } from "../types";
import { useSiteProjects } from "../store";

export function SitesGalleryPage() {
  const { projects, create } = useSiteProjects();
  const navigate = useNavigate();

  function handleCreate(preset: SitePreset) {
    const project = create(preset);
    navigate(`/sites/${project.id}`);
  }

  return (
    <div className="min-h-screen bg-surface-dark">
      <div className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-muted transition hover:text-white">
              <ArrowLeft size={16} />
            </Link>
            <Globe size={20} className="text-accent" />
            <div>
              <h1 className="text-lg font-semibold text-white">Site Studio</h1>
              <p className="text-xs text-muted">
                Choose the site type first so Octos can scaffold the right workspace.
              </p>
            </div>
          </div>
          <span className="text-xs text-muted">
            {projects.length} project{projects.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {(Object.entries(SITE_PRESETS) as Array<[SitePreset, (typeof SITE_PRESETS)[SitePreset]]>).map(
            ([preset, definition]) => (
              <button
                key={preset}
                onClick={() => handleCreate(preset)}
                className="rounded-2xl border border-border bg-surface p-5 text-left transition hover:border-accent/40 hover:bg-surface-container"
              >
                <div className="flex items-center justify-between">
                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
                    {definition.label}
                  </span>
                  <Plus size={16} className="text-muted" />
                </div>
                <h2 className="mt-4 text-xl font-semibold text-white">
                  {definition.title}
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted">
                  {definition.description}
                </p>
                <div className="mt-4 text-[11px] uppercase tracking-[0.18em] text-muted/70">
                  {definition.template}
                </div>
              </button>
            ),
          )}
        </div>

        {projects.length > 0 && (
          <div className="mt-10">
            <div className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
              Recent Sessions
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  to={`/sites/${project.id}`}
                  className="rounded-2xl border border-border bg-surface p-4 transition hover:border-accent/30 hover:bg-surface-container"
                >
                  <div className="text-sm font-medium text-white">{project.title}</div>
                  <div className="mt-1 text-xs text-muted">
                    {project.template} • {project.siteKind}
                  </div>
                  <div className="mt-3 text-[11px] text-muted/70">
                    Updated {new Date(project.updatedAt).toLocaleString()}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
