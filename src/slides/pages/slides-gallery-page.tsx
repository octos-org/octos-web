import { useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Presentation, Plus, Search, ArrowLeft } from "lucide-react";
import { useSlidesProjects, searchSlidesProjects } from "../store";
import { TEMPLATES, TEMPLATE_COLORS } from "../constants";

export function SlidesGalleryPage() {
  const { projects, create, remove } = useSlidesProjects();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    let results = search ? searchSlidesProjects(search, projects) : projects;
    if (filter !== "all") {
      if (filter === "recent") {
        const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
        results = results.filter((p) => p.updatedAt > week);
      } else {
        results = results.filter((p) => p.template === filter);
      }
    }
    return results;
  }, [projects, search, filter]);

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
    <div className="min-h-screen bg-surface-dark">
      {/* Header */}
      <div className="border-b border-border bg-surface">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-muted hover:text-white transition">
              <ArrowLeft size={16} />
            </Link>
            <Presentation size={20} className="text-accent" />
            <h1 className="text-lg font-semibold text-white">Slides Gallery</h1>
            <span className="text-xs text-muted">
              {projects.length} deck{projects.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search slides..."
                className="pl-9 pr-3 py-1.5 rounded-lg bg-surface-dark border border-border text-sm text-white placeholder-muted focus:outline-none focus:border-accent w-60"
              />
            </div>
            <button
              onClick={handleDemo}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-container text-muted text-sm font-medium hover:text-white transition"
            >
              Demo
            </button>
            <button
              onClick={handleNew}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/80 transition"
            >
              <Plus size={14} />
              New Deck
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="max-w-6xl mx-auto px-6 py-3">
        <div className="flex gap-2">
          {[
            { value: "all", label: "All" },
            ...TEMPLATES,
            { value: "recent", label: "Recent", color: "text-yellow-400" },
          ].map((t) => (
            <button
              key={t.value}
              onClick={() => setFilter(t.value)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                filter === t.value
                  ? "bg-accent/20 text-accent"
                  : "bg-surface text-muted hover:text-white hover:bg-surface-container"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="max-w-6xl mx-auto px-6 py-4">
        {filtered.length === 0 ? (
          <div className="text-center py-20 text-muted">
            <Presentation size={48} className="mx-auto mb-4 opacity-30" />
            <p className="text-sm">
              {search
                ? "No slides match your search."
                : "No slide decks yet. Create one to get started."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((p) => (
              <Link
                key={p.id}
                to={`/slides/${p.id}`}
                className="group rounded-xl border border-border bg-surface hover:bg-surface-container hover:border-accent/30 transition overflow-hidden"
              >
                {/* Thumbnail */}
                <div className="aspect-video bg-surface-dark flex items-center justify-center">
                  {p.slides[0]?.thumbnailUrl ? (
                    <img
                      src={p.slides[0].thumbnailUrl}
                      alt={p.title}
                      className="w-full h-full object-cover"
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
                  <h3 className="text-sm font-medium text-white truncate">
                    {p.title}
                  </h3>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
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
