import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Clock3,
  Layers3,
  Presentation,
  Plus,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { AuthenticatedFileImage } from "../components/authenticated-file-image";
import { useSlidesProjects, searchSlidesProjects } from "../store";
import { TEMPLATES, TEMPLATE_COLORS } from "../constants";
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

function DeckStat({
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

export function SlidesGalleryPage() {
  const { projects, create } = useSlidesProjects();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [recentCutoff] = useState(() => Date.now() - 7 * 24 * 60 * 60 * 1000);

  const filtered = useMemo(() => {
    let results = search ? searchSlidesProjects(search, projects) : projects;
    if (filter !== "all") {
      if (filter === "recent") {
        results = results.filter((p) => p.updatedAt > recentCutoff);
      } else {
        results = results.filter((p) => p.template === filter);
      }
    }
    return results;
  }, [projects, search, filter, recentCutoff]);

  const summary = useMemo(() => {
    const totalSlides = projects.reduce((sum, project) => sum + project.slides.length, 0);
    const recentCount = projects.filter((project) => project.updatedAt > recentCutoff).length;
    const templateCount = new Set(projects.map((project) => project.template)).size;
    const latest = projects[0]?.updatedAt;
    return {
      totalSlides,
      recentCount,
      templateCount,
      latestLabel: latest ? formatShortDate(latest) : "No decks",
    };
  }, [projects, recentCutoff]);

  const handleNew = () => {
    const project = create("Untitled Deck");
    navigate(`/slides/${project.id}`);
  };

  const handleDemo = () => {
    const project = create("AI Industry Report 2026", {
      template: "business",
      tags: ["business", "ai", "2026"],
      slides: [
        { index: 0, title: "AI Industry Report 2026", notes: "Title slide", layout: "title" as const },
        { index: 1, title: "Market Overview", notes: "Global AI market reached $500B in 2026", layout: "content" as const },
        { index: 2, title: "Key Players", notes: "Top companies by market cap and revenue", layout: "two-column" as const },
        { index: 3, title: "Technology Trends", notes: "LLMs, multimodal AI, autonomous agents", layout: "content" as const },
        { index: 4, title: "Conclusion", notes: "AI continues to accelerate across industries", layout: "conclusion" as const },
      ],
    });
    navigate(`/slides/${project.id}`);
  };

  return (
    <WorkbenchPage>
      <WorkbenchTopbar
        backTo="/"
        icon={Presentation}
        context="Creation Workspace"
        title="Slides"
        subtitle="Deck library and generation sessions"
        badge={
          <WorkbenchStatusPill>
            {projects.length} deck{projects.length !== 1 ? "s" : ""}
          </WorkbenchStatusPill>
        }
        actions={
          <>
            <div className="workbench-topbar-search relative min-w-0 max-sm:w-full">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search slides..."
                className="workbench-input w-64 py-1.5 pl-9 pr-3 text-sm placeholder-muted max-sm:w-full"
              />
            </div>
            <button
              onClick={handleDemo}
              className="workbench-button flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium"
            >
              Demo
            </button>
            <button
              onClick={handleNew}
              className="workbench-button workbench-button-primary flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium"
            >
              <Plus size={14} />
              New Deck
            </button>
          </>
        }
      />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 max-sm:px-3">
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
            <div className="workbench-panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="shell-kicker">Deck Operations</p>
                  <h2 className="mt-2 text-xl font-semibold text-text-strong">
                    Draft, generate, and return to local decks.
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                    Search across deck titles, tags, slide titles, and notes; filter by
                    template when the library grows.
                  </p>
                </div>
                <WorkbenchStatusPill tone="accent">
                  {filtered.length} visible
                </WorkbenchStatusPill>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
                <DeckStat
                  icon={Presentation}
                  label="Decks"
                  value={projects.length}
                  tone="accent"
                />
                <DeckStat
                  icon={Layers3}
                  label="Slides"
                  value={summary.totalSlides}
                />
                <DeckStat
                  icon={Sparkles}
                  label="Templates used"
                  value={summary.templateCount}
                  tone="link"
                />
                <DeckStat
                  icon={Clock3}
                  label="Latest update"
                  value={summary.latestLabel}
                />
              </div>
            </div>

            <div className="workbench-panel-muted p-5">
              <p className="shell-kicker">Generation Lane</p>
              <h2 className="mt-2 text-lg font-semibold text-text-strong">
                Start with a blank deck or seed a demo.
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                The gallery stays local-first; generated outputs are persisted in the
                browser library before you open the editor.
              </p>
              <div className="mt-5 grid gap-2">
                <button
                  type="button"
                  onClick={handleNew}
                  className="workbench-button workbench-button-primary flex items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold"
                >
                  <span>New blank deck</span>
                  <Plus size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={handleDemo}
                  className="workbench-button flex items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold"
                >
                  <span>Seed business demo</span>
                  <Sparkles size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </section>

          <div className="workbench-panel-muted flex flex-wrap items-center gap-2 p-3">
          {[
            { value: "all", label: "All" },
            ...TEMPLATES,
            { value: "recent", label: "Recent", color: "text-yellow-400" },
          ].map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setFilter(t.value)}
              data-active={filter === t.value ? "true" : undefined}
              className="workbench-button px-3 text-xs font-medium"
            >
              {t.label}
            </button>
          ))}
          </div>

          <section>
            <WorkbenchSectionHeader
              title="Library"
              description="Recent decks, generated outputs, and local drafts"
            />
            {filtered.length === 0 ? (
              <div className="workbench-panel-muted py-20 text-center text-muted">
                <Presentation size={48} className="mx-auto mb-4 opacity-30" />
                <p className="text-sm">
                  {search
                    ? "No slides match your search."
                    : "No slide decks yet. Create one to get started."}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filtered.map((p) => (
                  <Link
                    key={p.id}
                    to={`/slides/${p.id}`}
                    className="workbench-card group flex min-h-64 flex-col overflow-hidden"
                  >
                    <div className="flex aspect-video items-center justify-center bg-surface-dark">
                      {p.slides[0]?.thumbnailUrl ? (
                        <AuthenticatedFileImage
                          filePath={p.slides[0].thumbnailUrl}
                          alt={p.title}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Presentation
                          size={36}
                          className="text-muted/30 transition group-hover:text-muted/50"
                        />
                      )}
                    </div>
                    <div className="flex flex-1 flex-col p-4">
                      <h3 className="truncate text-base font-semibold text-text-strong">
                        {p.title}
                      </h3>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded px-2 py-1 text-[10px] font-bold ${
                            TEMPLATE_COLORS[p.template] || "bg-gray-500/20 text-gray-400"
                          }`}
                        >
                          {p.template}
                        </span>
                        <span className="text-xs text-muted">
                          {p.slides.length} slide{p.slides.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="mt-auto pt-4 text-[11px] text-muted/70">
                        Updated {formatShortDate(p.updatedAt)}
                      </div>
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
