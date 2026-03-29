import { useNavigate } from "react-router-dom";
import { FolderOpen, Trash2, FileText, Headphones, Presentation, Image } from "lucide-react";
import type { StudioProject, OutputType } from "@/studio/types";

const outputIcons: Record<OutputType, typeof FileText> = {
  summary: FileText,
  report: FileText,
  podcast: Headphones,
  slides: Presentation,
  infographic: Image,
  comic: Image,
  website: FileText,
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ProjectCard({
  project,
  onDelete,
}: {
  project: StudioProject;
  onDelete: (id: string) => void;
}) {
  const navigate = useNavigate();

  const outputTypes = [...new Set(project.outputs.map((o) => o.type))];

  return (
    <button
      onClick={() => navigate(`/studio/${project.id}`)}
      className="group relative flex flex-col rounded-2xl bg-surface-container p-5 text-left elevation-1 hover:elevation-2 hover:bg-surface-elevated transition-all"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-container text-accent">
          <FolderOpen size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="truncate text-sm font-medium text-text-strong">
            {project.title}
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {project.sources.length} source{project.sources.length !== 1 ? "s" : ""} &middot; {project.outputs.length} output{project.outputs.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {outputTypes.length > 0 && (
        <div className="mt-3 flex gap-1.5">
          {outputTypes.slice(0, 4).map((t) => {
            const Icon = outputIcons[t] || FileText;
            return (
              <div
                key={t}
                className="flex h-7 items-center gap-1 rounded-lg bg-surface-light px-2 text-[10px] text-muted"
              >
                <Icon size={12} />
                {t}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 text-[10px] text-muted/60">
        {formatDate(project.updatedAt)}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(project.id);
        }}
        className="absolute right-3 top-3 rounded-lg p-1.5 text-muted opacity-0 hover:bg-red-600/20 hover:text-red-400 group-hover:opacity-100 transition-opacity"
      >
        <Trash2 size={14} />
      </button>
    </button>
  );
}
