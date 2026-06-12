import { useNavigate } from "react-router-dom";
import { HomeNav } from "@/components/home-nav";
import { MessageSquare, ArrowRight, Presentation, Globe, MonitorSmartphone, Mic } from "lucide-react";
import { unlockAudio } from "@/home/voice/audio-playback";

export function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="workbench-shell flex h-screen flex-col">
      <HomeNav />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 max-sm:px-3">
          <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
            <div>
              <p className="text-xs font-semibold uppercase text-muted">Command Center</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-strong">
                Octos Workspace
              </h1>
            </div>
            <div className="workbench-badge px-2.5 py-1.5">AI workbench</div>
          </header>

          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-text-strong">Workspaces</h2>
              <span className="text-xs text-muted">Chat, decks, sites</span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <button
              onClick={() => navigate("/chat")}
              className="workbench-card flex min-h-28 items-center gap-4 p-5 text-left"
            >
              <div className="workbench-icon-tile flex h-11 w-11 shrink-0 items-center justify-center">
                <MessageSquare size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Start chat</div>
                <div className="mt-1 text-xs text-muted">Session workspace</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
            <button
              onClick={() => navigate("/slides")}
              className="workbench-card flex min-h-28 items-center gap-4 p-5 text-left"
            >
              <div className="workbench-icon-tile flex h-11 w-11 shrink-0 items-center justify-center">
                <Presentation size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Slides</div>
                <div className="mt-1 text-xs text-muted">Deck workspace</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
            <button
              onClick={() => navigate("/sites")}
              className="workbench-card flex min-h-28 items-center gap-4 p-5 text-left"
            >
              <div className="workbench-icon-tile flex h-11 w-11 shrink-0 items-center justify-center">
                <Globe size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Sites</div>
                <div className="mt-1 text-xs text-muted">Site workspace</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-text-strong">Utilities</h2>
              <span className="text-xs text-muted">Display and voice</span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <button
              onClick={() => navigate("/home")}
              className="workbench-card flex min-h-24 w-full items-center gap-4 p-5 text-left"
            >
              <div className="workbench-icon-tile flex h-11 w-11 shrink-0 items-center justify-center">
                <MonitorSmartphone size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Home Assistant</div>
                <div className="mt-1 text-xs text-muted">Ambient display</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>

            <button
              onClick={() => {
                // Unlock the Web Audio context INSIDE this click gesture so the
                // voice reply (which arrives seconds later, off-gesture) can
                // play — browser autoplay policy blocks a later resume().
                unlockAudio();
                navigate("/voice");
              }}
              className="workbench-card flex min-h-24 w-full items-center gap-4 p-5 text-left"
            >
              <div className="workbench-icon-tile flex h-11 w-11 shrink-0 items-center justify-center">
                <Mic size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">Voice</div>
                <div className="mt-1 text-xs text-muted">Hands-free session</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
