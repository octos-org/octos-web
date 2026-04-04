import { Search, List, LayoutGrid, GalleryHorizontalEnd } from "lucide-react";
import type { ContentFilters } from "@/api/content";

const CATEGORIES = [
  { key: "", label: "All" },
  { key: "report", label: "Reports" },
  { key: "audio", label: "Audio" },
  { key: "slides", label: "Slides" },
  { key: "image", label: "Images" },
  { key: "video", label: "Video" },
  { key: "other", label: "Other" },
] as const;

const DATE_RANGES = [
  { key: "", label: "All time" },
  { key: "7", label: "7d" },
  { key: "30", label: "30d" },
] as const;

export type ViewMode = "list" | "grid" | "cover";

interface FilterBarProps {
  filters: ContentFilters;
  onChange: (filters: ContentFilters) => void;
  viewMode: ViewMode;
  onViewChange: (mode: ViewMode) => void;
}

export function ContentFilterBar({
  filters,
  onChange,
  viewMode,
  onViewChange,
}: FilterBarProps) {
  const setCategory = (cat: string) =>
    onChange({ ...filters, category: cat || undefined, offset: 0 });

  const setSearch = (search: string) =>
    onChange({ ...filters, search: search || undefined, offset: 0 });

  const setDateRange = (days: string) => {
    if (!days) {
      onChange({ ...filters, from: undefined, offset: 0 });
    } else {
      const d = new Date();
      d.setDate(d.getDate() - parseInt(days));
      onChange({ ...filters, from: d.toISOString(), offset: 0 });
    }
  };

  const activeDays = filters.from
    ? (() => {
        const diff = Math.round(
          (Date.now() - new Date(filters.from).getTime()) / 86400000,
        );
        return String(diff);
      })()
    : "";

  return (
    <div className="space-y-2 px-3 pb-2">
      {/* Category pills */}
      <div className="flex flex-wrap gap-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setCategory(cat.key)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              (filters.category || "") === cat.key
                ? "bg-accent/20 text-accent"
                : "bg-surface-container text-muted hover:text-text"
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Search + date + view toggle row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Search..."
            value={filters.search || ""}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 w-full rounded-lg bg-surface-container pl-7 pr-2 text-xs text-text placeholder:text-muted outline-none focus:ring-1 focus:ring-accent/50"
          />
        </div>

        {/* Date range quick-select */}
        <div className="flex rounded-lg bg-surface-container">
          {DATE_RANGES.map((dr) => (
            <button
              key={dr.key}
              onClick={() => setDateRange(dr.key)}
              className={`px-2 py-1 text-[10px] font-medium transition-colors first:rounded-l-lg last:rounded-r-lg ${
                activeDays === dr.key
                  ? "bg-accent/20 text-accent"
                  : "text-muted hover:text-text"
              }`}
            >
              {dr.label}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div className="flex rounded-lg bg-surface-container">
          <button
            onClick={() => onViewChange("list")}
            className={`p-1.5 transition-colors first:rounded-l-lg ${
              viewMode === "list" ? "text-accent" : "text-muted hover:text-text"
            }`}
            title="List view"
          >
            <List className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onViewChange("grid")}
            className={`p-1.5 transition-colors ${
              viewMode === "grid" ? "text-accent" : "text-muted hover:text-text"
            }`}
            title="Grid view"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onViewChange("cover")}
            className={`p-1.5 transition-colors last:rounded-r-lg ${
              viewMode === "cover"
                ? "text-accent"
                : "text-muted hover:text-text"
            }`}
            title="Cover flow"
          >
            <GalleryHorizontalEnd className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
