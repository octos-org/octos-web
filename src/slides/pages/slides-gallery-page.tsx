import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Presentation, Plus, Search, ArrowLeft } from "lucide-react";

import { AuthenticatedFileImage } from "../components/authenticated-file-image";
import { useSlidesProjects, searchSlidesProjects } from "../store";
import { TEMPLATES, TEMPLATE_COLORS } from "../constants";

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
    <div className="workbench-shell min-h-screen">
      {/* Header */}
      <div className="workbench-topbar">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4 max-sm:px-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/" className="glass-icon-button flex h-9 w-9 items-center justify-center">
              <ArrowLeft size={16} />
            </Link>
            <div className="workbench-icon-tile flex h-9 w-9 items-center justify-center">
              <Presentation size={18} />
            </div>
            <h1 className="truncate text-lg font-semibold text-text-strong">Slides Gallery</h1>
            <span className="workbench-badge px-2 py-1">
              {projects.length} deck{projects.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative min-w-0 max-sm:w-full">
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
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="mx-auto max-w-6xl px-6 py-3 max-sm:px-3">
        <div className="flex flex-wrap gap-2">
          {[
            { value: "all", label: "All" },
            ...TEMPLATES,
            { value: "recent", label: "Recent", color: "text-yellow-400" },
          ].map((t) => (
            <button
              key={t.value}
              onClick={() => setFilter(t.value)}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition ${
                filter === t.value
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border bg-surface text-muted hover:bg-surface-container hover:text-text-strong"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="mx-auto max-w-6xl px-6 py-4 max-sm:px-3">
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
                className="workbench-card group overflow-hidden"
              >
                {/* Thumbnail */}
                <div className="flex aspect-video items-center justify-center bg-surface-dark">
                  {p.slides[0]?.thumbnailUrl ? (
                    <AuthenticatedFileImage
                      filePath={p.slides[0].thumbnailUrl}
                      alt={p.title}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Presentation
                      size={32}
                      className="text-muted/30 group-hover:text-muted/50 transition"
                    />
                  )}
                </div>
                {/* Info */}
                <div className="p-3">
                  <h3 className="truncate text-sm font-medium text-text-strong">
                    {p.title}
                  </h3>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        TEMPLATE_COLORS[p.template] || "bg-gray-500/20 text-gray-400"
                      }`}
                    >
                      {p.template}
                    </span>
                    <span className="text-[10px] text-muted">
                      {p.slides.length} slides
                    </span>
                    <span className="text-[10px] text-muted">
                      {new Date(p.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
