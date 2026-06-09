import { useState, useEffect, useRef } from "react";
import { Puzzle, Loader2, Wrench, RefreshCw, Trash2, Plus, Download } from "lucide-react";
import { getMyProfileSkills, removeSkill, installSkill, type SkillInfo } from "./settings-api";

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Install form state
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);

  // Track which skill is being removed
  const [removingSkill, setRemovingSkill] = useState<string | null>(null);

  const refreshSkills = async () => {
    setError(null);
    const data = await getMyProfileSkills();
    if (mountedRef.current) {
      setSkills(data);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    getMyProfileSkills().then((data) => {
      if (!cancelled) {
        setSkills(data);
        setLoading(false);
      }
    });
    return () => { cancelled = true; mountedRef.current = false; };
  }, []);

  const handleRemove = async (name: string) => {
    if (!window.confirm(`Remove skill '${name}'?`)) return;
    setRemovingSkill(name);
    setError(null);
    const ok = await removeSkill(name);
    if (mountedRef.current) {
      setRemovingSkill(null);
      if (ok) {
        await refreshSkills();
      } else {
        setError(`Failed to remove skill '${name}'.`);
      }
    }
  };

  const handleInstall = async () => {
    const source = installSource.trim();
    if (!source) return;
    setInstalling(true);
    setError(null);
    setInstallMessage(null);
    const ok = await installSkill(source);
    if (mountedRef.current) {
      setInstalling(false);
      if (ok) {
        setInstallSource("");
        setInstallMessage("Skill installed. Restart gateway to load new skills.");
        await refreshSkills();
      } else {
        setError(`Failed to install skill from '${source}'.`);
      }
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Puzzle size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">Installed Skills</h3>
              <p className="text-xs text-muted">
                {skills.length > 0
                  ? `${skills.length} skill${skills.length === 1 ? "" : "s"} installed`
                  : "Skills extend agent capabilities"}
              </p>
            </div>
          </div>
          <button
            onClick={refreshSkills}
            className="glass-icon-button rounded-xl p-2.5"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-xs text-red-400">
            {error}
          </div>
        )}

        {installMessage && (
          <div className="mb-4 rounded-xl bg-accent/10 px-4 py-3 text-xs text-accent">
            {installMessage}
          </div>
        )}

        {skills.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-10 text-center">
            <Puzzle size={32} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">No skills installed yet</p>
            <p className="mt-1 text-xs text-muted/60">
              Install a skill below to get started
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {skills.map((skill) => (
              <div
                key={skill.name}
                className="flex items-center gap-4 rounded-xl bg-surface-container/60 px-4 py-3.5 border border-transparent hover:border-border transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-strong truncate">
                      {skill.name}
                    </span>
                    {skill.version && (
                      <span className="shrink-0 rounded-md bg-surface-dark/60 px-1.5 py-0.5 text-[10px] font-mono text-muted">
                        v{skill.version}
                      </span>
                    )}
                  </div>
                  {skill.source_repo && (
                    <p className="mt-0.5 text-xs text-muted truncate">
                      {skill.source_repo}
                    </p>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-1.5 text-xs font-medium text-muted">
                  <Wrench size={12} />
                  <span>{skill.tool_count} tool{skill.tool_count === 1 ? "" : "s"}</span>
                </div>
                <button
                  onClick={() => handleRemove(skill.name)}
                  disabled={removingSkill === skill.name}
                  className="shrink-0 rounded-lg p-2 text-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition"
                  title={`Remove ${skill.name}`}
                >
                  {removingSkill === skill.name ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Install skill section */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Download size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">Install Skill</h3>
            <p className="text-xs text-muted">Add a new skill from a repository or local path</p>
          </div>
        </div>

        <div className="flex gap-3">
          <input
            type="text"
            value={installSource}
            onChange={(e) => setInstallSource(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleInstall(); }}
            placeholder="octos-org/system-skills, https://host/org/repo.git, or ./skills/my-skill"
            className="flex-1 rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
          />
          <button
            onClick={handleInstall}
            disabled={installing || !installSource.trim()}
            className="flex shrink-0 items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
          >
            {installing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            {installing ? "Installing..." : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}
