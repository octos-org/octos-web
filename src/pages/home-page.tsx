import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Clock,
  Globe,
  LogOut,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Plus,
  Presentation,
  Settings,
  Sparkles,
  Star,
  Sun,
} from "lucide-react";
import { useAuth } from "@/auth/auth-context";
import { useTheme } from "@/hooks/use-theme";
import { StudioNav } from "@/components/studio-nav";
import {
  recordProjectOpened,
  useProjects,
  type ProjectSummary,
} from "@/store/project-store";
import { useSlidesProjects } from "@/slides/store";

function formatRelativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** The design's more_horiz overflow menu on recent-project cards. */
function ProjectMenu({
  project,
  onToggleFavorite,
  onSetArchived,
}: {
  project: ProjectSummary;
  onToggleFavorite: () => void;
  onSetArchived: (archived: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // First item takes focus so the menu keyboard contract works.
    menuRef.current?.querySelector("button")?.focus();
    function closeIfOutside(target: EventTarget | null) {
      if (rootRef.current && !rootRef.current.contains(target as Node)) {
        setOpen(false);
      }
    }
    function onDocPointerDown(event: MouseEvent) {
      closeIfOutside(event.target);
    }
    // Keyboard path: activating another card's trigger never fires a
    // mousedown, but it does move focus — close on focus leaving us.
    function onDocFocusIn(event: FocusEvent) {
      closeIfOutside(event.target);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        );
        if (items.length === 0) return;
        event.preventDefault();
        const index = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(index + delta + items.length) % items.length]?.focus();
      }
    }
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("focusin", onDocFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("focusin", onDocFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="studio-ghost-button p-1"
        aria-label={`Project options for ${project.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          ref={menuRef}
          className="studio-menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="studio-menu-item"
            onClick={() => {
              onToggleFavorite();
              setOpen(false);
            }}
          >
            <Star size={14} aria-hidden="true" />
            {project.favorite ? "Unfavorite" : "Favorite"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="studio-menu-item"
            onClick={() => {
              onSetArchived(!project.archived);
              setOpen(false);
            }}
          >
            {project.archived ? (
              <ArchiveRestore size={14} aria-hidden="true" />
            ) : (
              <Archive size={14} aria-hidden="true" />
            )}
            {project.archived ? "Restore" : "Archive"}
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  variant,
  onOpen,
  onToggleFavorite,
  onSetArchived,
}: {
  project: ProjectSummary;
  /** "recent" gets the overflow menu; "favorite" gets the filled star. */
  variant: "recent" | "favorite";
  onOpen: () => void;
  onToggleFavorite: () => void;
  onSetArchived: (archived: boolean) => void;
}) {
  // A div with role="button" rather than <button>: the card hosts nested
  // interactive controls (menu / star), which cannot legally live inside
  // a real button element.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${project.title}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        // Only when the card itself is focused — Enter/Space on the
        // nested controls must keep their own semantics.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="studio-card studio-card-interactive flex h-48 min-w-0 flex-col justify-between p-6"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <h3 className="studio-headline line-clamp-2 min-w-0 text-2xl leading-tight">
            {project.title}
          </h3>
        {variant === "favorite" ? (
          <button
            type="button"
            aria-label="Remove from favorites"
            aria-pressed="true"
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite();
            }}
            className="studio-ghost-button shrink-0 p-1"
          >
            <Star
              size={16}
              className="fill-current text-text-strong"
              aria-hidden="true"
            />
          </button>
        ) : (
          <ProjectMenu
            project={project}
            onToggleFavorite={onToggleFavorite}
            onSetArchived={onSetArchived}
          />
        )}
        </div>
        <span className="studio-chip max-w-full self-start overflow-hidden">
          {project.meta}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Clock size={14} aria-hidden="true" />
        Modified {formatRelativeTime(project.updatedAt)}
      </div>
    </div>
  );
}

export function HomePage() {
  const { uiStyle } = useTheme();

  if (uiStyle === "legacy-blue") {
    return <LegacyBlueHomePage />;
  }

  return <WarmWorkbenchHomePage />;
}

type LauncherTab = "all" | "shared" | "archive";

function WarmWorkbenchHomePage() {
  const navigate = useNavigate();
  const { projects, toggleFavorite, setArchived } = useProjects();
  const { create: createDeck } = useSlidesProjects();
  const [chooserOpen, setChooserOpen] = useState(false);
  const [tab, setTab] = useState<LauncherTab>("all");
  const createRef = useRef<HTMLElement>(null);

  const recentProjects = projects.filter((p) => !p.archived).slice(0, 12);
  const archivedProjects = projects.filter((p) => p.archived).slice(0, 12);
  const favoriteProjects = projects.filter((p) => p.favorite && !p.archived);

  const startStudioSession = () => {
    const id = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Register the session in the shared titles record right away so the
    // launcher lists it even if the user never visits /chat (the studio
    // workspace only updates the record once the server names it).
    try {
      const raw = localStorage.getItem("octos_session_titles");
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      const titles =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      localStorage.setItem(
        "octos_session_titles",
        JSON.stringify({ ...titles, [id]: "Studio Project" }),
      );
    } catch {
      // Listing is best-effort; the session itself still works.
    }
    navigate(`/studio/${id}`);
  };

  const startSlideDeck = () => {
    const project = createDeck("Untitled Deck");
    navigate(`/slides/${project.id}`);
  };

  const openCreate = () => {
    setChooserOpen(true);
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    createRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
  };

  const renderProjectGrid = (
    items: ProjectSummary[],
    variant: "recent" | "favorite",
  ) => (
    <div
      className={`grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3${
        variant === "favorite"
          ? " opacity-80 transition-opacity hover:opacity-100"
          : ""
      }`}
    >
      {items.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          variant={variant}
          onOpen={() => {
            recordProjectOpened(project.id);
            navigate(project.href);
          }}
          onToggleFavorite={() => toggleFavorite(project.id)}
          onSetArchived={(archived) => setArchived(project.id, archived)}
        />
      ))}
    </div>
  );

  return (
    <div className="studio-shell h-screen overflow-y-auto">
      <StudioNav
        actions={
          <button
            type="button"
            className="studio-button-primary mr-1 h-10 max-md:hidden"
            onClick={openCreate}
          >
            Create Project
          </button>
        }
      />

      <div>
        <main className="mx-auto flex w-full max-w-[1024px] flex-col gap-16 px-10 py-14 max-sm:px-4">
          <header className="flex flex-col items-center gap-3 text-center">
            <h1 className="studio-display text-5xl max-sm:text-4xl">
              Octos Home
            </h1>
            <p className="max-w-2xl text-lg text-muted">
              Your digital sanctuary for deep work. Organize, collaborate, and
              launch your next big idea.
            </p>
          </header>

          <section ref={createRef} className="flex flex-col items-center gap-4">
            <button
              type="button"
              onClick={() => setChooserOpen((open) => !open)}
              aria-expanded={chooserOpen}
              className="studio-card studio-card-interactive group flex w-full max-w-3xl flex-col items-center justify-center gap-2 p-8 text-center"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container text-muted transition-colors group-hover:bg-accent group-hover:text-on-accent">
                <Plus size={22} aria-hidden="true" />
              </span>
              <span className="studio-headline mt-2 block text-2xl">
                Create new project
              </span>
              <span className="block text-sm text-muted">
                Start with a blank canvas or choose a template.
              </span>
            </button>
            {chooserOpen && (
              <div className="grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={startStudioSession}
                  className="studio-skill-tile"
                >
                  <span className="studio-skill-tile-icon">
                    <Sparkles size={18} aria-hidden="true" />
                  </span>
                  <span className="studio-skill-tile-label">
                    Studio session
                  </span>
                </button>
                <button
                  type="button"
                  onClick={startSlideDeck}
                  className="studio-skill-tile"
                >
                  <span className="studio-skill-tile-icon">
                    <Presentation size={18} aria-hidden="true" />
                  </span>
                  <span className="studio-skill-tile-label">Slide deck</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/sites")}
                  className="studio-skill-tile"
                >
                  <span className="studio-skill-tile-icon">
                    <Globe size={18} aria-hidden="true" />
                  </span>
                  <span className="studio-skill-tile-label">Site</span>
                </button>
              </div>
            )}
          </section>

          <div className="flex flex-col gap-8">
            <div className="flex w-full gap-8 border-b border-border pb-0">
              <button
                type="button"
                className="studio-tab"
                data-active={tab === "all"}
                aria-pressed={tab === "all"}
                onClick={() => setTab("all")}
              >
                All Projects
              </button>
              <button
                type="button"
                className="studio-tab"
                data-active={tab === "shared"}
                aria-pressed={tab === "shared"}
                onClick={() => setTab("shared")}
              >
                Shared with Me
              </button>
              <button
                type="button"
                className="studio-tab"
                data-active={tab === "archive"}
                aria-pressed={tab === "archive"}
                onClick={() => setTab("archive")}
              >
                Archive
              </button>
            </div>

            {tab === "all" && (
              <>
                <section className="flex flex-col gap-8">
                  <h2 className="studio-headline text-3xl">Recent Projects</h2>
                  {recentProjects.length > 0 ? (
                    renderProjectGrid(recentProjects, "recent")
                  ) : (
                    <div className="studio-empty-state">
                      No projects yet — create your first one above.
                    </div>
                  )}
                </section>

                {favoriteProjects.length > 0 && (
                  <section className="flex flex-col gap-8">
                    <h2 className="studio-headline flex items-center gap-2 text-3xl">
                      <Star
                        size={24}
                        className="fill-current text-text-strong"
                        aria-hidden="true"
                      />
                      Favorite Projects
                    </h2>
                    {renderProjectGrid(favoriteProjects, "favorite")}
                  </section>
                )}
              </>
            )}

            {tab === "shared" && (
              <section className="flex flex-col gap-8">
                <h2 className="studio-headline text-3xl">Shared with Me</h2>
                <div className="studio-empty-state">
                  Nothing shared yet — sharing arrives with multi-user Octos.
                </div>
              </section>
            )}

            {tab === "archive" && (
              <section className="flex flex-col gap-8">
                <h2 className="studio-headline text-3xl">Archived Projects</h2>
                {archivedProjects.length > 0 ? (
                  renderProjectGrid(archivedProjects, "recent")
                ) : (
                  <div className="studio-empty-state">
                    No archived projects yet.
                  </div>
                )}
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
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
        // "Return to the modern shell" — since the Ivory Obsidian rebrand
        // that shell is the flagship style, not "warm".
        onClick={() => setUiStyle("ivory-obsidian")}
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
