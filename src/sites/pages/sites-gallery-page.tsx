import { useMemo, useState } from "react";
import {
  Clock3,
  FileCode2,
  Globe,
  LayoutTemplate,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { SITE_PRESETS, type SitePreset } from "../types";
import { useSiteProjects } from "../store";
import {
  WorkbenchPage,
  WorkbenchSectionHeader,
  WorkbenchStatusPill,
  WorkbenchTopbar,
} from "@/components/workbench-shell";

function formatShortDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function SiteStat({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  tone?: "default" | "accent" | "link";
}) {
  const color =
    tone === "accent" ? "text-accent" : tone === "link" ? "text-link" : "text-muted";
  return (
    <div className="rounded-lg border border-border bg-surface-container/70 p-4">
      <Icon size={17} className={color} aria-hidden="true" />
      <div className="mt-3 text-2xl font-semibold text-text-strong">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}

export function SitesGalleryPage() {
  const { projects, create } = useSiteProjects();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | string>("all");

  const presetEntries = useMemo(
    () =>
      Object.entries(SITE_PRESETS) as Array<
        [SitePreset, (typeof SITE_PRESETS)[SitePreset]]
      >,
    [],
  );

  const siteKinds = useMemo(
    () => Array.from(new Set(presetEntries.map(([, definition]) => definition.siteKind))),
    [presetEntries],
  );

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((project) => {
      const matchesQuery =
        !q ||
        project.title.toLowerCase().includes(q) ||
        project.template.toLowerCase().includes(q) ||
        project.siteKind.toLowerCase().includes(q) ||
        project.slug.toLowerCase().includes(q);
      const matchesKind = kindFilter === "all" || project.siteKind === kindFilter;
      return matchesQuery && matchesKind;
    });
  }, [projects, search, kindFilter]);

  const summary = useMemo(() => {
    const scaffolded = projects.filter((project) => project.scaffolded).length;
    const latest = projects[0]?.updatedAt;
    return {
      scaffolded,
      presetCount: presetEntries.length,
      latestLabel: latest ? formatShortDate(latest) : "No sites",
    };
  }, [projects, presetEntries.length]);

  function handleCreate(preset: SitePreset) {
    const project = create(preset);
    navigate(`/sites/${project.id}`);
  }

  return (
    <WorkbenchPage>
      <WorkbenchTopbar
        backTo="/"
        icon={Globe}
        context="Creation Workspace"
        title="Site Studio"
        subtitle="Project library and scaffold presets"
        badge={
          <WorkbenchStatusPill>
            {projects.length} project{projects.length !== 1 ? "s" : ""}
          </WorkbenchStatusPill>
        }
        actions={
          <div className="workbench-topbar-search relative min-w-0 max-sm:w-full">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sites..."
              className="workbench-input w-64 py-1.5 pl-9 pr-3 text-sm placeholder-muted max-sm:w-full"
            />
          </div>
        }
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 max-sm:px-3">
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
            <div className="workbench-panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="shell-kicker">Site Production</p>
                  <h2 className="mt-2 text-xl font-semibold text-text-strong">
                    Scaffold, preview, and return to local web projects.
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                    Presets map to concrete templates; recent sessions keep their
                    slug, site kind, and scaffold state visible.
                  </p>
                </div>
                <WorkbenchStatusPill tone="accent">
                  {filteredProjects.length} visible
                </WorkbenchStatusPill>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
                <SiteStat
                  icon={Globe}
                  label="Projects"
                  value={projects.length}
                  tone="accent"
                />
                <SiteStat
                  icon={FileCode2}
                  label="Scaffolded"
                  value={summary.scaffolded}
                />
                <SiteStat
                  icon={LayoutTemplate}
                  label="Presets"
                  value={summary.presetCount}
                  tone="link"
                />
                <SiteStat
                  icon={Clock3}
                  label="Latest update"
                  value={summary.latestLabel}
                />
              </div>
            </div>

            <div className="workbench-panel-muted p-5">
              <p className="shell-kicker">Preset Router</p>
              <h2 className="mt-2 text-lg font-semibold text-text-strong">
                Choose the output shape before generation.
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                Course, docs, product app, and tool presets keep the site editor
                grounded in the right file structure.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {["all", ...siteKinds].map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setKindFilter(kind)}
                    data-active={kindFilter === kind ? "true" : undefined}
                    className="workbench-button px-3 text-xs font-medium capitalize"
                  >
                    {kind}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section>
            <WorkbenchSectionHeader
              title="Create"
              description="Preset scaffolds"
            />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {presetEntries.map(([preset, definition]) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => handleCreate(preset)}
                  className="workbench-card flex min-h-56 flex-col p-5 text-left"
                >
                  <div className="flex items-center justify-between gap-3">
                    <WorkbenchStatusPill tone="accent">
                      {definition.label}
                    </WorkbenchStatusPill>
                    <div className="workbench-icon-tile flex h-10 w-10 items-center justify-center">
                      <Plus size={16} aria-hidden="true" />
                    </div>
                  </div>
                  <h3 className="mt-5 text-xl font-semibold text-text-strong">
                    {definition.title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-muted">
                    {definition.description}
                  </p>
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-5 text-[11px] font-semibold uppercase text-muted/70">
                    <span>{definition.template}</span>
                    <span className="h-1 w-1 rounded-full bg-muted/40" />
                    <span>{definition.siteKind}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section>
            <WorkbenchSectionHeader
              title="Recent Sessions"
              description="Scaffolded site workspaces"
            />
            {filteredProjects.length === 0 ? (
              <div className="workbench-panel-muted py-16 text-center text-muted">
                <Globe size={42} className="mx-auto mb-4 opacity-30" />
                <p className="text-sm">
                  {search || kindFilter !== "all"
                    ? "No sites match the current filters."
                    : "No site projects yet. Pick a preset to create one."}
                </p>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {filteredProjects.map((project) => (
                  <Link
                    key={project.id}
                    to={`/sites/${project.id}`}
                    className="workbench-card p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-base font-semibold text-text-strong">
                          {project.title}
                        </div>
                        <div className="mt-1 text-xs text-muted">
                          {project.template} / {project.siteKind}
                        </div>
                      </div>
                      <WorkbenchStatusPill tone={project.scaffolded ? "success" : "default"}>
                        {project.scaffolded ? "Ready" : "Draft"}
                      </WorkbenchStatusPill>
                    </div>
                    <div className="mt-4 rounded-md border border-border bg-surface-dark px-3 py-2 font-mono text-xs text-muted">
                      /{project.slug}
                    </div>
                    <div className="mt-3 text-[11px] text-muted/70">
                      Updated {formatShortDate(project.updatedAt)}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </WorkbenchPage>
  );
}
