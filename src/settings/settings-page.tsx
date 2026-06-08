import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/auth-context";
import { useTheme } from "@/hooks/use-theme";
import {
  ArrowLeft,
  Sun,
  Moon,
  User,
  Cpu,
  Puzzle,
  Radio,
  Loader2,
} from "lucide-react";
import { getMyProfile, type Profile } from "./settings-api";
import { ProfileTab } from "./profile-tab";
import { LlmTab } from "./llm-tab";
import { SkillsTab } from "./skills-tab";
import { ChannelsTab } from "./channels-tab";

type TabId = "profile" | "llm" | "skills" | "channels";

const TABS: { id: TabId; label: string; icon: typeof User }[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "llm", label: "LLM", icon: Cpu },
  { id: "skills", label: "Skills", icon: Puzzle },
  { id: "channels", label: "Channels", icon: Radio },
];

export function AdminSettingsPage() {
  const navigate = useNavigate();
  const { portal } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("profile");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  // Derive accessible profiles from portal context (no extra API call needed)
  const accessibleProfiles = portal?.accessible_profiles ?? [];
  // Initialize selectedProfileId directly from portal (no effect needed)
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => portal?.home_profile_id ?? "",
  );

  // Fetch the current profile via GET /api/my/profile.
  // loading starts as true; after the first fetch it resets via the callback.
  useEffect(() => {
    let cancelled = false;
    getMyProfile().then((data) => {
      if (!cancelled) {
        setProfile(data);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedProfileId]);

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
      {/* Header */}
      <nav className="flex items-center gap-4 px-6 py-4 shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="rounded-xl p-2 text-muted hover:bg-surface-container hover:text-text-strong transition"
          title="Go back"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-2.5">
          <img
            src="/images/octos-logo-color.svg"
            alt="Octos"
            className="h-6 w-auto select-none"
          />
          <span className="text-lg font-semibold tracking-tight text-text-strong">
            Settings
          </span>
        </div>

        <div className="flex-1" />

        {/* Profile selector (when multiple accessible profiles) */}
        {accessibleProfiles.length > 1 && (
          <select
            value={selectedProfileId}
            onChange={(e) => setSelectedProfileId(e.target.value)}
            className="rounded-xl bg-surface-container px-3 py-2 text-sm text-text outline-none border border-transparent focus:border-accent/30 transition"
          >
            {accessibleProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={toggleTheme}
          className="rounded-xl p-2.5 text-muted hover:bg-surface-container hover:text-text-strong transition"
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </nav>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Tab rail */}
          <aside className="w-56 shrink-0 border-r border-border/50 px-3 py-4 overflow-y-auto">
            <div className="space-y-1">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium transition ${
                    activeTab === id
                      ? "bg-accent/12 text-accent border border-accent/20"
                      : "text-muted hover:bg-surface-container hover:text-text-strong border border-transparent"
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </aside>

          {/* Content area */}
          <main className="flex-1 min-w-0 overflow-y-auto px-8 py-6">
            <div className="mx-auto max-w-2xl">
              {profile ? (
                <>
                  {activeTab === "profile" && (
                    <ProfileTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                  {activeTab === "llm" && (
                    <LlmTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                  {activeTab === "skills" && <SkillsTab />}
                  {activeTab === "channels" && <ChannelsTab profile={profile} />}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-20">
                  <p className="text-sm text-muted">No profile available</p>
                  <p className="mt-1 text-xs text-muted/60">
                    Create a profile on the server to get started
                  </p>
                </div>
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
