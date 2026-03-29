import { useState } from "react";
import { MessageSquare, Presentation, ArrowLeft, Sun, Moon } from "lucide-react";
import { Link } from "react-router-dom";
import { useSlides } from "../context/slides-context";
import { useTheme } from "@/hooks/use-theme";

export function SlidesEditorLayout({
  previewPanel,
  chatPanel,
}: {
  previewPanel: React.ReactNode;
  chatPanel?: React.ReactNode;
}) {
  const [showChat, setShowChat] = useState(true);
  const { project } = useSlides();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
        <div className="flex items-center gap-3">
          <Link
            to="/slides"
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-muted hover:text-white hover:bg-surface-container transition text-sm"
          >
            <ArrowLeft size={16} />
            Back
          </Link>
          <div className="w-px h-5 bg-border" />
          <Presentation size={16} className="text-accent" />
          <span className="text-sm font-medium text-white truncate max-w-sm">
            {project?.title || "Untitled Deck"}
          </span>
          {project && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface-container text-muted">
              {project.slides.length} slides
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="rounded-lg p-2 text-muted hover:text-text transition"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={() => setShowChat(!showChat)}
            className={`rounded-lg p-2 transition ${
              showChat
                ? "bg-surface-container text-accent"
                : "text-muted hover:text-text"
            }`}
            title="Toggle chat"
          >
            <MessageSquare size={16} />
          </button>
        </div>
      </div>

      {/* Two-panel layout: chat (left) + preview (right) */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Chat */}
        {showChat && (
          <div className="w-96 shrink-0 border-r border-border bg-surface">
            {chatPanel || (
              <div className="flex h-full items-center justify-center text-xs text-muted/50">
                Chat with the slides agent
              </div>
            )}
          </div>
        )}

        {/* Right: Preview */}
        <div className="flex-1 min-w-0 bg-surface-dark">{previewPanel}</div>
      </div>
    </div>
  );
}
