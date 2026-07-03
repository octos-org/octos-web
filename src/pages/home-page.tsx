import { useNavigate } from "react-router-dom";
import { useState, type ReactNode } from "react";
import { HomeNav } from "@/components/home-nav";
import {
  Activity,
  ArrowRight,
  Globe,
  LogOut,
  MessageSquare,
  Mic,
  Moon,
  MonitorSmartphone,
  Presentation,
  Settings,
  Sun,
} from "lucide-react";
import { useAuth } from "@/auth/auth-context";
import { useTheme } from "@/hooks/use-theme";
import { unlockAudio } from "@/home/voice/audio-playback";
import { useOminixRuntimeSummary } from "@/home/use-ominix-runtime-summary";
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

function HomeStatusTile({
  icon: Icon,
  title,
  description,
  ariaLabel,
  tone,
  onClick,
}: {
  icon: typeof Activity;
  title: ReactNode;
  description: string;
  ariaLabel: string;
  tone: "link" | "accent";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid="home-status-tile"
      className="workbench-card p-4 text-left transition hover:border-accent/45 hover:bg-surface-elevated"
    >
      <Icon size={18} className={tone === "link" ? "text-link" : "text-accent"} />
      <div className="mt-3 text-2xl font-semibold text-text-strong">{title}</div>
      <div className="mt-1 text-xs text-muted">{description}</div>
    </button>
  );
}

export function HomePage() {
  const { uiStyle } = useTheme();

  if (uiStyle === "legacy-blue") {
    return <LegacyBlueHomePage />;
  }

  return <WarmWorkbenchHomePage />;
}

function WarmWorkbenchHomePage() {
  const navigate = useNavigate();
  const counts = useLocalProjectCounts();
  const voiceRuntime = useOminixRuntimeSummary();

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
              <HomeStatusTile
                icon={Activity}
                title="Ready"
                description="Open chat"
                ariaLabel="Open chat status"
                tone="link"
                onClick={() => navigate("/chat")}
              />
              <HomeStatusTile
                icon={Presentation}
                title={counts.slides}
                description="Local decks"
                ariaLabel="Open deck count"
                tone="accent"
                onClick={() => navigate("/slides")}
              />
              <HomeStatusTile
                icon={Globe}
                title={counts.sites}
                description="Local sites"
                ariaLabel="Open site count"
                tone="link"
                onClick={() => navigate("/sites")}
              />
              <HomeStatusTile
                icon={MonitorSmartphone}
                title="Touch"
                description="Display mode"
                ariaLabel="Open display console"
                tone="accent"
                onClick={() => navigate("/home")}
              />
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
                meta={
                  voiceRuntime.needsAttention ? (
                    <WorkbenchStatusPill tone={voiceRuntime.tone}>
                      {voiceRuntime.label}
                    </WorkbenchStatusPill>
                  ) : undefined
                }
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

function LegacyHomeNav() {
  const { user, portal, logout } = useAuth();
  const { theme, toggleTheme, setUiStyle } = useTheme();
  const navigate = useNavigate();

  return (
    <nav className="flex items-center gap-4 px-6 py-4">
      <button
        type="button"
        onClick={() => navigate("/")}
        className="flex items-center gap-2.5"
        aria-label="Octos home"
      >
        <img
          src="/images/octos-logo-color.svg"
          alt="Octos"
          className="h-7 w-auto select-none"
        />
        <span className="text-xl font-semibold tracking-tight text-text-strong">octos</span>
      </button>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setUiStyle("warm")}
        className="flex items-center gap-2 rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text hover:bg-surface-elevated"
      >
        Workbench
      </button>
      <button
        type="button"
        onClick={() => navigate("/chat")}
        className="flex items-center gap-2 rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text hover:bg-surface-elevated"
      >
        <MessageSquare size={16} />
        Chat
      </button>
      {portal?.can_access_admin_portal && (
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="rounded-xl p-2.5 text-muted hover:bg-surface-container hover:text-text-strong"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={18} />
        </button>
      )}
      <button
        type="button"
        onClick={toggleTheme}
        className="rounded-xl p-2.5 text-muted hover:bg-surface-container hover:text-text-strong"
        title={theme === "dark" ? "Light mode" : "Dark mode"}
        aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      {user && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="max-w-[18rem] truncate text-sm text-muted">{user.email}</span>
          <button
            type="button"
            onClick={logout}
            className="rounded-xl p-2 text-muted hover:bg-surface-container hover:text-text-strong"
            aria-label="Log out"
            title="Log out"
          >
            <LogOut size={16} />
          </button>
        </div>
      )}
    </nav>
  );
}

function LegacyActionCard({
  icon: Icon,
  title,
  description,
  toneClass,
  onClick,
}: {
  icon: typeof MessageSquare;
  title: string;
  description: string;
  toneClass: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-4 rounded-2xl bg-surface-container p-6 text-left transition-all hover:bg-surface-elevated elevation-1"
    >
      <div
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${toneClass}`}
      >
        <Icon size={24} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-strong">{title}</div>
        <div className="text-xs text-muted">{description}</div>
      </div>
      <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
    </button>
  );
}

function LegacyBlueHomePage() {
  const navigate = useNavigate();

  return (
    <div className="legacy-blue-home flex h-screen flex-col bg-surface-dark">
      <LegacyHomeNav />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-3">
            <LegacyActionCard
              icon={MessageSquare}
              title="Start chat"
              description="Research, ask questions, explore"
              toneClass="bg-link/10 text-link"
              onClick={() => navigate("/chat")}
            />
            <LegacyActionCard
              icon={Presentation}
              title="Slides"
              description="Build presentations with AI"
              toneClass="bg-amber-500/10 text-amber-500"
              onClick={() => navigate("/slides")}
            />
            <LegacyActionCard
              icon={Globe}
              title="Sites"
              description="Create websites and landing pages"
              toneClass="bg-emerald-500/10 text-emerald-500"
              onClick={() => navigate("/sites")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
