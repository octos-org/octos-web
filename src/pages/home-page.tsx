import { useNavigate } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { HomeNav } from "@/components/home-nav";
import {
  Activity,
  ArrowRight,
  Globe,
  MessageSquare,
  Mic,
  MonitorSmartphone,
  Presentation,
  Settings,
} from "lucide-react";
import { unlockAudio } from "@/home/voice/audio-playback";
import {
  WorkbenchPage,
  WorkbenchRouteCard,
  WorkbenchSectionHeader,
  WorkbenchStatusPill,
} from "@/components/workbench-shell";

function readStoredCount(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function useLocalProjectCounts() {
  const [counts] = useState(() => ({
    slides: readStoredCount("octos-slides-projects"),
    sites: readStoredCount("octos-sites-projects"),
  }));

  return counts;
}

function QuickAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="workbench-button flex items-center justify-between gap-3 px-4 text-left text-sm font-semibold"
    >
      <span>{children}</span>
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const counts = useLocalProjectCounts();

  return (
    <WorkbenchPage>
      <HomeNav />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-7 px-6 py-7 max-sm:px-3">
          <header className="grid gap-5 border-b border-border pb-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="shell-kicker">Command Center</p>
                <WorkbenchStatusPill tone="accent">Local workbench</WorkbenchStatusPill>
              </div>
              <h1 className="mt-3 text-3xl font-semibold text-text-strong max-sm:text-2xl">
                Octos Workspace
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
                Jump back into active sessions, creative workspaces, and local
                runtime controls from one dense surface.
              </p>
              <div className="mt-5 grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-3">
                <QuickAction onClick={() => navigate("/chat")}>Start chat</QuickAction>
                <QuickAction onClick={() => navigate("/slides")}>Create deck</QuickAction>
                <QuickAction onClick={() => navigate("/sites")}>Create site</QuickAction>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="workbench-card p-4">
                <Activity size={18} className="text-link" />
                <div className="mt-3 text-2xl font-semibold text-text-strong">Ready</div>
                <div className="mt-1 text-xs text-muted">Workbench shell</div>
              </div>
              <div className="workbench-card p-4">
                <Presentation size={18} className="text-accent" />
                <div className="mt-3 text-2xl font-semibold text-text-strong">{counts.slides}</div>
                <div className="mt-1 text-xs text-muted">Local decks</div>
              </div>
              <div className="workbench-card p-4">
                <Globe size={18} className="text-link" />
                <div className="mt-3 text-2xl font-semibold text-text-strong">{counts.sites}</div>
                <div className="mt-1 text-xs text-muted">Local sites</div>
              </div>
              <div className="workbench-card p-4">
                <MonitorSmartphone size={18} className="text-accent" />
                <div className="mt-3 text-2xl font-semibold text-text-strong">Touch</div>
                <div className="mt-1 text-xs text-muted">Display mode</div>
              </div>
            </div>
          </header>

          <section>
            <WorkbenchSectionHeader
              title="Production Surfaces"
              description="Work areas with persistent outputs"
            />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <WorkbenchRouteCard
                icon={MessageSquare}
                title="Chat"
                description="Session stack and task output"
                to="/chat"
                meta="Conversation runtime"
              />
              <WorkbenchRouteCard
                icon={Presentation}
                title="Slides"
                description="Deck generation and preview"
                to="/slides"
                meta={`${counts.slides} local deck${counts.slides === 1 ? "" : "s"}`}
              />
              <WorkbenchRouteCard
                icon={Globe}
                title="Sites"
                description="Site scaffold and file output"
                to="/sites"
                meta={`${counts.sites} local site${counts.sites === 1 ? "" : "s"}`}
              />
            </div>
          </section>

          <section>
            <WorkbenchSectionHeader
              title="Runtime Controls"
              description="Touch display, voice, and administrative surfaces"
            />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <WorkbenchRouteCard
                icon={MonitorSmartphone}
                title="Display"
                description="Ambient touch console"
                to="/home"
                meta="Metro grid"
              />
              <WorkbenchRouteCard
                icon={Mic}
                title="Voice"
                description="Hands-free session control"
                onClick={() => {
                  // Unlock the Web Audio context inside this click gesture so
                  // the voice reply can play after the async response arrives.
                  unlockAudio();
                  navigate("/voice");
                }}
                meta="Audio runtime"
              />
              <WorkbenchRouteCard
                icon={Settings}
                title="Settings"
                description="Profiles, models, and local services"
                to="/settings"
                meta="Admin control"
              />
            </div>
          </section>
        </div>
      </div>
    </WorkbenchPage>
  );
}
