import { useNavigate } from "react-router-dom";
import { HomeNav } from "@/components/home-nav";
import { MessageSquare, ArrowRight, Presentation, Globe, Code2 } from "lucide-react";

export function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
      <HomeNav />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-8">
          {/* Quick actions */}
          <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-4">
            <button
              onClick={() => navigate("/chat")}
              className="flex items-center gap-4 rounded-2xl bg-surface-container p-6 text-left hover:bg-surface-elevated elevation-1 transition-all"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-link/10 text-link">
                <MessageSquare size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Start chat</div>
                <div className="text-xs text-muted">Research, ask questions, explore</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
            <button
              onClick={() => navigate("/coding")}
              className="flex items-center gap-4 rounded-2xl bg-surface-container p-6 text-left hover:bg-surface-elevated elevation-1 transition-all"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-500">
                <Code2 size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Coding</div>
                <div className="text-xs text-muted">Focused app workspace</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
            <button
              onClick={() => navigate("/slides")}
              className="flex items-center gap-4 rounded-2xl bg-surface-container p-6 text-left hover:bg-surface-elevated elevation-1 transition-all"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500">
                <Presentation size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Slides</div>
                <div className="text-xs text-muted">Build presentations with AI</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
            <button
              onClick={() => navigate("/sites")}
              className="flex items-center gap-4 rounded-2xl bg-surface-container p-6 text-left hover:bg-surface-elevated elevation-1 transition-all"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500">
                <Globe size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Sites</div>
                <div className="text-xs text-muted">Create websites and landing pages</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
