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
  Users,
  Shield,
  Wrench,
  Activity,
  Server,
  Loader2,
} from "lucide-react";
import { getMyProfile, type Profile } from "./settings-api";
import { ProfileTab } from "./profile-tab";
import { LlmTab } from "./llm-tab";
import { SkillsTab } from "./skills-tab";
import { ChannelsTab } from "./channels-tab";
import { UsersTab } from "./users-tab";
import { SandboxTab } from "./sandbox-tab";
import { ToolsTab } from "./tools-tab";
import { SystemTab } from "./system-tab";
import { ServerTab } from "./server-tab";

type TabId = "profile" | "llm" | "skills" | "channels" | "sandbox" | "tools" | "users" | "system" | "server";

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof User;
  adminOnly?: boolean;
}

const TABS: TabDef[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "llm", label: "LLM", icon: Cpu },
  { id: "skills", label: "Skills", icon: Puzzle },
  { id: "channels", label: "Channels", icon: Radio },
  { id: "sandbox", label: "Sandbox", icon: Shield },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "users", label: "Users", icon: Users, adminOnly: true },
  { id: "system", label: "System", icon: Activity, adminOnly: true },
  { id: "server", label: "Server", icon: Server, adminOnly: true },
];

export function AdminSettingsPage() {
  const navigate = useNavigate();
  const { portal } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("profile");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const accessibleProfiles = portal?.accessible_profiles ?? [];
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => portal?.home_profile_id ?? "",
  );

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

  const isAdminOnlyTab = activeTab === "system" || activeTab === "server" || activeTab === "users";

  return (
    <div className="flex h-screen flex-col bg-surface-dark">
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
          <aside className="w-56 shrink-0 border-r border-border/50 px-3 py-4 overflow-y-auto">
            <div className="space-y-1">
              {TABS.filter(
                (t) => !t.adminOnly || portal?.can_access_admin_portal,
              ).map(({ id, label, icon: Icon, adminOnly }) => (
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
                  {adminOnly && (
                    <span className="ml-auto rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent/70">
                      Admin
                    </span>
                  )}
                </button>
              ))}
            </div>
          </aside>

          <main className="flex-1 min-w-0 overflow-y-auto px-8 py-6">
            <div className={`mx-auto ${isAdminOnlyTab ? "max-w-3xl" : "max-w-2xl"}`}>
              {activeTab === "system" && portal?.can_access_admin_portal && <SystemTab />}
              {activeTab === "server" && portal?.can_access_admin_portal && <ServerTab />}
              {activeTab === "users" && portal?.can_access_admin_portal && <UsersTab />}

              {!isAdminOnlyTab && profile ? (
                <>
                  {activeTab === "profile" && (
                    <ProfileTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                  {activeTab === "llm" && (
                    <LlmTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                  {activeTab === "skills" && <SkillsTab />}
                  {activeTab === "channels" && <ChannelsTab profile={profile} onProfileUpdated={setProfile} />}
                  {activeTab === "sandbox" && (
                    <SandboxTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                  {activeTab === "tools" && (
                    <ToolsTab profile={profile} onProfileUpdated={setProfile} />
                  )}
                </>
              ) : !isAdminOnlyTab ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <p className="text-sm text-muted">No profile available</p>
                  <p className="mt-1 text-xs text-muted/60">
                    Create a profile on the server to get started
                  </p>
                </div>
              ) : null}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
