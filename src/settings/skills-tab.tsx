import { useState, useEffect, useRef } from "react";
import { Puzzle, Loader2, Wrench, RefreshCw, Trash2, Plus, Download, Package, Search, Check, Tag } from "lucide-react";
import { getMyProfileSkills, removeSkill, installSkill, getSkillRegistry, type SkillInfo, type HubPackage } from "./settings-api";

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

  // Octos Hub state
  const [hubPackages, setHubPackages] = useState<HubPackage[]>([]);
  const [hubLoading, setHubLoading] = useState(true);
  const [hubSearch, setHubSearch] = useState("");
  const [installingHub, setInstallingHub] = useState<string | null>(null);

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
    Promise.all([getMyProfileSkills(), getSkillRegistry()]).then(([skillData, registryData]) => {
      if (!cancelled) {
        setSkills(skillData);
        setLoading(false);
        setHubPackages(registryData);
        setHubLoading(false);
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

  const handleHubInstall = async (pkg: HubPackage) => {
    setInstallingHub(pkg.name);
    setError(null);
    setInstallMessage(null);
    const ok = await installSkill(pkg.repo);
    if (mountedRef.current) {
      setInstallingHub(null);
      if (ok) {
        setInstallMessage(`Skill package '${pkg.name}' installed. Restart gateway to load new skills.`);
        await refreshSkills();
      } else {
        setError(`Failed to install skill package '${pkg.name}'.`);
      }
    }
  };

  // Derive which individual skill names from the hub are already installed
  const installedNames = new Set(skills.map((s) => s.name));

  // Derive installed packages: a hub package is "installed" when ALL its skills are present
  const isPackageInstalled = (pkg: HubPackage) =>
    pkg.skills.length > 0 && pkg.skills.every((s) => installedNames.has(s));

  // Filter hub packages by search query
  const filteredPackages = hubPackages.filter((pkg) => {
    const q = hubSearch.toLowerCase();
    if (!q) return true;
    return (
      pkg.name.toLowerCase().includes(q) ||
      (pkg.description ?? "").toLowerCase().includes(q) ||
      pkg.tags.some((t) => t.toLowerCase().includes(q)) ||
      pkg.skills.some((s) => s.toLowerCase().includes(q))
    );
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="glass-section rounded-lg p-6">
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
      <div className="glass-section rounded-lg p-6">
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

      {/* Octos Hub section */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Package size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">Octos Hub</h3>
              <p className="text-xs text-muted">Browse and install skill packages from the registry</p>
            </div>
          </div>
          {!hubLoading && hubPackages.length > 0 && (
            <span className="text-xs text-muted">
              {filteredPackages.length} of {hubPackages.length} package{hubPackages.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* Search */}
        {!hubLoading && hubPackages.length > 0 && (
          <div className="relative mb-4">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted/60 pointer-events-none" />
            <input
              type="text"
              value={hubSearch}
              onChange={(e) => setHubSearch(e.target.value)}
              placeholder="Search packages, skills, or tags..."
              className="w-full rounded-xl bg-surface-container pl-9 pr-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
            />
          </div>
        )}

        {hubLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={18} className="animate-spin text-muted" />
          </div>
        ) : hubPackages.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-10 text-center">
            <Package size={32} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">No packages in registry</p>
            <p className="mt-1 text-xs text-muted/60">The registry returned no results</p>
          </div>
        ) : filteredPackages.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-8 text-center">
            <Search size={24} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">No packages match "{hubSearch}"</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {filteredPackages.map((pkg) => {
              const installed = isPackageInstalled(pkg);
              const isInstalling = installingHub === pkg.name;
              return (
                <div
                  key={pkg.name}
                  className="flex flex-col gap-3 rounded-xl bg-surface-container/60 border border-transparent hover:border-border p-4 transition"
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-text-strong truncate">
                          {pkg.name}
                        </span>
                        {pkg.version && (
                          <span className="shrink-0 rounded-md bg-surface-dark/60 px-1.5 py-0.5 text-[10px] font-mono text-muted">
                            v{pkg.version}
                          </span>
                        )}
                        {installed && (
                          <span className="shrink-0 flex items-center gap-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                            <Check size={9} strokeWidth={3} />
                            Installed
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted truncate">{pkg.repo}</p>
                    </div>
                    {installed ? (
                      <div className="shrink-0 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-accent bg-accent/10 cursor-default select-none">
                        <Check size={12} strokeWidth={2.5} />
                        Installed
                      </div>
                    ) : (
                      <button
                        onClick={() => handleHubInstall(pkg)}
                        disabled={isInstalling || installingHub !== null}
                        className="shrink-0 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-40 transition"
                      >
                        {isInstalling ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Download size={12} />
                        )}
                        {isInstalling ? "Installing…" : "Install"}
                      </button>
                    )}
                  </div>

                  {/* Description */}
                  {pkg.description && (
                    <p className="text-xs text-muted leading-relaxed line-clamp-2">
                      {pkg.description}
                    </p>
                  )}

                  {/* Skills list */}
                  {pkg.skills.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Wrench size={11} className="shrink-0 text-muted/60" />
                      {pkg.skills.map((s) => (
                        <span
                          key={s}
                          className={`rounded-md px-1.5 py-0.5 text-[10px] font-mono transition ${
                            installedNames.has(s)
                              ? "bg-accent/15 text-accent"
                              : "bg-surface-dark/60 text-muted"
                          }`}
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Tags */}
                  {pkg.tags.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Tag size={10} className="shrink-0 text-muted/50" />
                      {pkg.tags.slice(0, 6).map((t) => (
                        <span
                          key={t}
                          className="rounded-md bg-surface-dark/40 px-1.5 py-0.5 text-[10px] text-muted/70"
                        >
                          {t}
                        </span>
                      ))}
                      {pkg.tags.length > 6 && (
                        <span className="text-[10px] text-muted/50">+{pkg.tags.length - 6} more</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
