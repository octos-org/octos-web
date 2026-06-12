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
    <div className="workbench-shell min-h-screen">
      <div className="workbench-topbar">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4 max-sm:px-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/" className="glass-icon-button flex h-9 w-9 items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div className="workbench-icon-tile flex h-9 w-9 items-center justify-center">
              <Globe size={18} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-text-strong">Site Studio</h1>
              <p className="text-xs text-muted">
                Project library and scaffold presets
              </p>
            </div>
          </div>
          <span className="workbench-badge px-2 py-1">
            {projects.length} project{projects.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-8 max-sm:px-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-text-strong">Create</h2>
          <span className="text-xs text-muted">Preset scaffolds</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {(Object.entries(SITE_PRESETS) as Array<[SitePreset, (typeof SITE_PRESETS)[SitePreset]]>).map(
            ([preset, definition]) => (
              <button
                key={preset}
                onClick={() => handleCreate(preset)}
                className="workbench-card min-h-44 p-5 text-left"
              >
                <div className="flex items-center justify-between">
                  <span className="workbench-badge px-2 py-0.5 text-[10px] text-accent">
                    {definition.label}
                  </span>
                  <Plus size={16} className="text-muted" />
                </div>
                <h3 className="mt-4 text-xl font-semibold text-text-strong">
                  {definition.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-muted">
                  {definition.description}
                </p>
                <div className="mt-4 text-[11px] font-semibold uppercase text-muted/70">
                  {definition.template}
                </div>
              </button>
            ),
          )}
        </div>

        {projects.length > 0 && (
          <div className="mt-10">
            <div className="mb-4 text-xs font-semibold uppercase text-muted">
              Recent Sessions
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  to={`/sites/${project.id}`}
                  className="workbench-card p-4"
                >
                  <div className="text-sm font-medium text-text-strong">{project.title}</div>
                  <div className="mt-1 text-xs text-muted">
                    {project.template} / {project.siteKind}
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
