import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { HomeNav } from "@/components/home-nav";
import { ProjectCard } from "@/components/project-card";
import { useStudioProjects } from "@/studio/store";
import { MessageSquare, FolderOpen, ArrowRight, Presentation, Globe } from "lucide-react";

export function HomePage() {
  const { projects, create, remove } = useStudioProjects();
  const navigate = useNavigate();

  const handleNewProject = useCallback(() => {
    const project = create("Untitled project");
    navigate(`/studio/${project.id}`);
  }, [create, navigate]);

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
      <HomeNav onNewProject={handleNewProject} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-8">
          {/* Quick actions */}
          <div className="mb-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <button
              onClick={handleNewProject}
              className="flex items-center gap-4 rounded-2xl bg-surface-container p-6 text-left hover:bg-surface-elevated elevation-1 transition-all"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-container text-accent">
                <FolderOpen size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-strong">New project</div>
                <div className="text-xs text-muted">Create content from sources</div>
              </div>
              <ArrowRight size={16} className="ml-auto shrink-0 text-muted" />
            </button>
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

          {/* Projects */}
          {projects.length > 0 ? (
            <>
              <h2 className="mb-4 text-sm font-medium text-muted uppercase tracking-wider">
                Projects
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((p) => (
                  <ProjectCard key={p.id} project={p} onDelete={remove} />
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-container text-muted">
                <FolderOpen size={28} />
              </div>
              <h2 className="mb-2 text-lg font-medium text-text-strong">No projects yet</h2>
              <p className="mb-6 max-w-sm text-sm text-muted">
                Create a project to start generating content from your research and sources.
              </p>
              <button
                onClick={handleNewProject}
                className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim"
              >
                Create your first project
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
