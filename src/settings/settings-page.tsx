import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/auth-context";
import {
  User,
  Cpu,
  Puzzle,
  Radio,
  Users,
  Shield,
  Wrench,
  Activity,
  Server,
  Waves,
  Loader2,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  WorkbenchPage,
  WorkbenchStatusPill,
  WorkbenchThemeButton,
  WorkbenchTopbar,
} from "@/components/workbench-shell";
import { getMyProfile, type Profile } from "./settings-api";
import { setSelectedProfileId as persistSelectedProfile } from "@/api/client";
import { ProfileTab } from "./profile-tab";
import { LlmTab } from "./llm-tab";
import { SkillsTab } from "./skills-tab";
import { ChannelsTab } from "./channels-tab";
import { UsersTab } from "./users-tab";
import { SandboxTab } from "./sandbox-tab";
import { ToolsTab } from "./tools-tab";
import { SystemTab } from "./system-tab";
import { ServerTab } from "./server-tab";
import { OminixTab } from "./ominix-tab";

type TabId = "profile" | "llm" | "skills" | "channels" | "sandbox" | "tools" | "users" | "system" | "server" | "ominix";

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
  { id: "ominix", label: "OminiX", icon: Waves, adminOnly: true },
];

export function AdminSettingsPage() {
  const { portal } = useAuth();
  const navigate = useNavigate();
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

  const isAdminOnlyTab = activeTab === "system" || activeTab === "server" || activeTab === "users" || activeTab === "ominix";

  return (
    <WorkbenchPage>
      <WorkbenchTopbar
        onBack={() => navigate(-1)}
        icon={SettingsIcon}
        context="Octos Control"
        title="Settings"
        subtitle="Profile, models, channels, operators, and local runtime"
        actions={
          <>
            {accessibleProfiles.length > 1 && (
              <select
                value={selectedProfileId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedProfileId(id);
                  persistSelectedProfile(id);
                }}
                className="workbench-input px-3 py-2 text-sm"
              >
                {accessibleProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </select>
            )}
            <WorkbenchThemeButton />
          </>
        }
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden max-md:flex-col">
          <aside className="workbench-rail settings-rail w-60 shrink-0 overflow-y-auto px-3 py-4 max-md:w-full max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-r-0 max-md:py-2">
            <div className="settings-tab-strip space-y-1 max-md:flex max-md:min-w-max max-md:gap-2 max-md:space-y-0">
              {TABS.filter(
                (t) => !t.adminOnly || portal?.can_access_admin_portal,
              ).map(({ id, label, icon: Icon, adminOnly }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  data-active={activeTab === id ? "true" : undefined}
                  className="settings-tab-button flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition max-md:w-auto max-md:shrink-0 max-md:px-3"
                >
                  <Icon size={16} />
                  {label}
                  {adminOnly && (
                    <span className="ml-auto">
                      <WorkbenchStatusPill tone="accent">Admin</WorkbenchStatusPill>
                    </span>
                  )}
                </button>
              ))}
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6 max-md:px-4 max-md:py-4">
            <div className={`mx-auto ${isAdminOnlyTab ? "max-w-4xl" : "max-w-3xl"}`}>
              {activeTab === "system" && portal?.can_access_admin_portal && <SystemTab />}
              {activeTab === "server" && portal?.can_access_admin_portal && <ServerTab />}
              {activeTab === "users" && portal?.can_access_admin_portal && profile && <UsersTab profile={profile} />}
              {activeTab === "ominix" && portal?.can_access_admin_portal && <OminixTab />}

              {!isAdminOnlyTab && profile ? (
                <>
                  {activeTab === "profile" && (
                    <ProfileTab
                      profile={profile}
                      onProfileUpdated={setProfile}
                      canDeleteProfile={Boolean(portal?.can_access_admin_portal)}
                    />
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
    </WorkbenchPage>
  );
}
