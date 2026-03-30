import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Edit3 } from "lucide-react";
import { useStudio } from "../context/studio-context";
import { useTheme } from "@/hooks/use-theme";
import { Sun, Moon } from "lucide-react";

export function ProjectHeader() {
  const { project, save } = useStudio();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project?.title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    setTitle(project?.title ?? "");
  }, [project?.title]);

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== project?.title) {
      save({ title: trimmed });
    }
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <button
        onClick={() => navigate("/")}
        className="rounded-xl p-2 text-muted hover:bg-surface-container hover:text-text-strong"
      >
        <ArrowLeft size={18} />
      </button>

      {editing ? (
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTitle();
            if (e.key === "Escape") {
              setTitle(project?.title ?? "");
              setEditing(false);
            }
          }}
          className="flex-1 rounded-lg bg-surface-container px-3 py-1.5 text-sm font-medium text-text-strong outline-none"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-container"
        >
          <span className="text-sm font-medium text-text-strong">
            {project?.title || "Untitled"}
          </span>
          <Edit3 size={12} className="text-muted opacity-0 group-hover:opacity-100" />
        </button>
      )}

      <div className="flex-1" />

      <button
        onClick={toggleTheme}
        className="rounded-xl p-2 text-muted hover:bg-surface-container hover:text-text-strong"
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </div>
  );
}
