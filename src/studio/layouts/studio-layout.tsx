import { useState } from "react";
import { MessageSquare, Layers } from "lucide-react";
import { ProjectHeader } from "../components/project-header";
import { SourcePanel } from "../components/source-panel";
import { StudioPanel } from "../components/studio-panel";

export function StudioLayout({ chatPanel }: { chatPanel?: React.ReactNode }) {
  const [showSources, setShowSources] = useState(true);
  const [showChat, setShowChat] = useState(true);

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
      {/* Header with panel toggles */}
      <div className="flex items-center">
        <div className="flex-1">
          <ProjectHeader />
        </div>
        <div className="flex items-center gap-1 px-4">
          <button
            onClick={() => setShowSources(!showSources)}
            className={`rounded-lg p-2 transition ${
              showSources ? "bg-surface-container text-accent" : "text-muted hover:text-text"
            }`}
            title="Toggle sources"
          >
            <Layers size={16} />
          </button>
          <button
            onClick={() => setShowChat(!showChat)}
            className={`rounded-lg p-2 transition ${
              showChat ? "bg-surface-container text-accent" : "text-muted hover:text-text"
            }`}
            title="Toggle chat"
          >
            <MessageSquare size={16} />
          </button>
        </div>
      </div>

      {/* Three-panel layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Sources */}
        {showSources && (
          <div className="w-64 shrink-0 border-r border-border bg-surface">
            <SourcePanel />
          </div>
        )}

        {/* Center: Studio */}
        <div className="flex-1 min-w-0 bg-surface-dark">
          <StudioPanel />
        </div>

        {/* Right: Chat */}
        {showChat && (
          <div className="w-96 shrink-0 border-l border-border bg-surface">
            {chatPanel || (
              <div className="flex h-full items-center justify-center text-xs text-muted/50">
                Chat panel
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
