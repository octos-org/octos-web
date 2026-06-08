import { useState, useEffect, useRef } from "react";
import { Puzzle, Loader2, Wrench, RefreshCw } from "lucide-react";
import { getMyProfileSkills, type SkillInfo } from "./settings-api";

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

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

  const handleRefresh = () => {
    setError(null);
    getMyProfileSkills().then((data) => {
      if (mountedRef.current) {
        setSkills(data);
      }
    });
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
            onClick={handleRefresh}
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

        {skills.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-10 text-center">
            <Puzzle size={32} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">No skills installed yet</p>
            <p className="mt-1 text-xs text-muted/60">
              Skills will appear here once configured on the server
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
